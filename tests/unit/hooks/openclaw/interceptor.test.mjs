import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = path.resolve(__dirname, '../../../../assets/plugins/openclaw/plugin.mjs');
const INTERCEPTOR_PATH = path.resolve(__dirname, '../../../../assets/plugins/openclaw/interceptor.mjs');

let tmpDir;
let pluginLoadSequence = 0;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pilot-openclaw-interceptor-'));
  process.env.LOONGSUITE_PILOT_DATA_DIR = tmpDir;
  process.env.LOONGSUITE_USER_ID = 'test-user';
});

afterEach(async () => {
  delete process.env.LOONGSUITE_PILOT_DATA_DIR;
  delete process.env.LOONGSUITE_USER_ID;
  delete process.env.INTERCEPTOR_CLI;
  vi.restoreAllMocks();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

async function loadPlugin() {
  const mod = await import(/* @vite-ignore */ `${PLUGIN_PATH}?interceptor=${++pluginLoadSequence}`);
  return mod.default;
}

function registerPlugin(plugin, { onOptions, api: apiExtras } = {}) {
  const handlers = {};
  const options = {};
  plugin.register({
    registrationMode: 'full',
    runtime: { version: '2026.6.10' },
    on: (name, handler, opts) => {
      handlers[name] = handler;
      if (opts) options[name] = opts;
    },
    ...apiExtras,
  });
  if (onOptions) Object.assign(onOptions, options);
  return handlers;
}

function writeRuntime(port, overrides = {}) {
  const dir = path.join(tmpDir, 'interceptor');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'runtime.json');
  fs.writeFileSync(file, `${JSON.stringify({
    service: 'loongsuite-pilot-interceptor',
    status: 'ok',
    pid: 4242,
    version: '1.0.2',
    daemon_port: port,
    packageVersion: '1.0.2',
    updatedAt: new Date().toISOString(),
    ...overrides,
  })}\n`);
  return file;
}

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

describe('OpenClaw interceptor client', () => {
  it('fail-opens silently when interceptor runtime is missing', async () => {
    const { createOpenClawInterceptor } = await import(/* @vite-ignore */ `${INTERCEPTOR_PATH}?missing=${Date.now()}`);
    const interceptor = createOpenClawInterceptor({ resolveDataDir: () => tmpDir });
    expect(interceptor.evaluate('before_tool_call', {
      toolName: 'exec',
      params: { command: 'id' },
      toolCallId: 'call-missing',
      sessionId: 's1',
    }, {})).toBeUndefined();
    expect(fs.existsSync(path.join(tmpDir, 'interceptor', 'logs', 'access.log'))).toBe(false);
    const stamp = new Date().toISOString().slice(0, 10);
    const files = fs.readdirSync(path.join(tmpDir, 'interceptor', 'tool-verdicts', stamp));
    const record = JSON.parse(fs.readFileSync(path.join(tmpDir, 'interceptor', 'tool-verdicts', stamp, files[0]), 'utf8'));
    expect(record).toMatchObject({
      agent: 'openclaw',
      sessionId: 's1',
      toolUseId: 'call-missing',
      phase: 'PreToolUse',
      result: 'unknown',
    });
  });

  it('blocks before_tool_call through the daemon and fail-opens on timeout', async () => {
    const { createOpenClawInterceptor, wrapHostReason } = await import(/* @vite-ignore */ `${INTERCEPTOR_PATH}?live=${Date.now()}`);
    const { server, port } = await listen((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          service: 'loongsuite-pilot-interceptor',
          status: 'ok',
          pid: 4242,
          version: '1.0.2',
          daemon_port: port,
        }));
        return;
      }
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          action: body.toolInput?.command === 'secret' ? 'block' : 'allow',
          reason: '[APIKEY_MASKED]',
          ruleId: 'apiKey',
          evaluatedRules: ['apiKey'],
        }));
      });
    });
    writeRuntime(port);
    try {
      const interceptor = createOpenClawInterceptor({ resolveDataDir: () => tmpDir });
      await expect(interceptor.evaluate('before_tool_call', {
        toolName: 'exec',
        params: { command: 'secret' },
        toolCallId: 'c1',
      }, { sessionId: 's1' })).resolves.toEqual({
        block: true,
        blockReason: wrapHostReason('PreToolUse', '[APIKEY_MASKED]'),
      });
      await expect(interceptor.evaluate('before_agent_run', { prompt: 'hello' }, {})).resolves.toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('uses spawnSync for tool_result_persist so the handler stays synchronous', async () => {
    const { createOpenClawInterceptor, wrapHostReason } = await import(/* @vite-ignore */ `${INTERCEPTOR_PATH}?sync=${Date.now()}`);
    writeRuntime(18791);
    const interceptor = createOpenClawInterceptor({
      resolveDataDir: () => tmpDir,
      spawnSyncImpl: () => ({
        status: 0,
        stdout: `${JSON.stringify({
          message: {
            toolCallId: 't1',
            content: [{ type: 'text', text: wrapHostReason('PostToolUse', '[DATABASEURL_MASKED]') }],
          },
        })}\n`,
        error: undefined,
      }),
      execPath: '/usr/bin/node',
    });
    process.env.INTERCEPTOR_CLI = path.join(tmpDir, 'cli.cjs');
    fs.writeFileSync(process.env.INTERCEPTOR_CLI, '');
    const result = interceptor.evaluate('tool_result_persist', {
      toolName: 'read',
      message: { toolCallId: 't1', content: [{ type: 'text', text: 'mysql://x' }] },
    }, {}, { sync: true });
    expect(result).toEqual({
      message: {
        toolCallId: 't1',
        content: [{ type: 'text', text: wrapHostReason('PostToolUse', '[DATABASEURL_MASKED]') }],
      },
    });
  });

  it('blocks tool_result_middleware with { result } and reuses that verdict for persist', async () => {
    const { createOpenClawInterceptor, wrapHostReason } = await import(/* @vite-ignore */ `${INTERCEPTOR_PATH}?mw=${Date.now()}`);
    let evaluateCount = 0;
    const { server, port } = await listen((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          service: 'loongsuite-pilot-interceptor',
          status: 'ok',
          pid: 4242,
          version: '1.0.2',
          daemon_port: port,
        }));
        return;
      }
      evaluateCount += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        action: 'block',
        reason: '[DATABASEURL_MASKED]',
        ruleId: 'databaseUrl',
        evaluatedRules: ['databaseUrl'],
      }));
    });
    writeRuntime(port);
    const spawnSyncImpl = vi.fn();
    const interceptor = createOpenClawInterceptor({
      resolveDataDir: () => tmpDir,
      spawnSyncImpl,
      execPath: '/usr/bin/node',
    });
    const original = {
      content: [{ type: 'text', text: 'mysql://agent:secret@127.0.0.1:3306/pilot' }],
      details: { status: 'completed' },
    };
    try {
      await expect(interceptor.evaluate('tool_result_middleware', {
        toolName: 'read',
        toolCallId: 't1',
        result: original,
      }, {})).resolves.toEqual({
        result: {
          ...original,
          content: [{ type: 'text', text: wrapHostReason('PostToolUse', '[DATABASEURL_MASKED]') }],
        },
      });
      expect(interceptor.evaluate('tool_result_persist', {
        toolName: 'read',
        toolCallId: 't1',
        message: { toolCallId: 't1', ...original },
      }, {}, { sync: true })).toEqual({
        message: {
          toolCallId: 't1',
          ...original,
          content: [{ type: 'text', text: wrapHostReason('PostToolUse', '[DATABASEURL_MASKED]') }],
        },
      });
      expect(evaluateCount).toBe(1);
      expect(spawnSyncImpl).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});

describe('OpenClaw plugin interceptor wiring', () => {
  it('registers intercept options on modern policy hooks only', async () => {
    const onOptions = {};
    registerPlugin(await loadPlugin(), { onOptions });
    expect(onOptions.before_agent_run).toMatchObject({ priority: 1000, timeoutMs: 8_000 });
    expect(onOptions.before_tool_call).toMatchObject({ priority: 1000, timeoutMs: 8_000 });
    expect(onOptions.tool_result_persist).toBeUndefined();
    expect(onOptions.before_message_write).toBeUndefined();
    expect(onOptions.llm_input).toBeUndefined();
  });

  it('keeps collection handlers fail-open and synchronous without a runtime', async () => {
    const handlers = registerPlugin(await loadPlugin());
    expect(handlers.before_tool_call(
      { runId: 'r1', toolName: 'exec', toolCallId: 't1', params: { command: 'true' } },
      { runId: 'r1', sessionId: 's1' },
    )).toBeUndefined();
    expect(handlers.tool_result_persist(
      { toolCallId: 't1', toolName: 'exec', message: { toolCallId: 't1', content: 'ok' } },
      { sessionKey: 'agent:main:test' },
    )).toBeUndefined();
    const stamp = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
    const logFile = path.join(tmpDir, 'logs', 'openclaw', `openclaw-${stamp}.jsonl`);
    const records = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
    expect(records.some(record => record['agent.openclaw.hook'] === 'before_tool_call')).toBe(true);
    const stampUtc = new Date().toISOString().slice(0, 10);
    const verdictDir = path.join(tmpDir, 'interceptor', 'tool-verdicts', stampUtc);
    const verdictFiles = fs.readdirSync(verdictDir).filter(name => name.endsWith('.json'));
    expect(verdictFiles.length).toBeGreaterThan(0);
    const verdicts = verdictFiles.map(name => JSON.parse(fs.readFileSync(path.join(verdictDir, name), 'utf8')));
    expect(verdicts.some(record => record.toolUseId === 't1' && record.phase === 'PreToolUse' && record.result === 'unknown')).toBe(true);
    expect(verdicts.some(record => record.toolUseId === 't1' && record.phase === 'PostToolUse' && record.result === 'unknown')).toBe(true);
  });

  it('returns an OpenClaw block decision from before_agent_run when the daemon blocks', async () => {
    const { wrapHostReason } = await import(/* @vite-ignore */ `${INTERCEPTOR_PATH}?plugin=${Date.now()}`);
    const { server, port } = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/health') {
        res.end(JSON.stringify({
          service: 'loongsuite-pilot-interceptor',
          status: 'ok',
          pid: 4242,
          version: '1.0.2',
          daemon_port: port,
        }));
        return;
      }
      res.end(JSON.stringify({
        action: 'block',
        reason: '[APIKEY_MASKED]',
        ruleId: 'apiKey',
        evaluatedRules: ['apiKey'],
      }));
    });
    writeRuntime(port);
    try {
      const handlers = registerPlugin(await loadPlugin());
      await expect(handlers.before_agent_run(
        { runId: 'r1', prompt: 'sk-secret' },
        { runId: 'r1', sessionId: 's1' },
      )).resolves.toEqual({
        outcome: 'block',
        reason: '[APIKEY_MASKED]',
        message: wrapHostReason('UserPromptSubmit', '[APIKEY_MASKED]'),
      });
    } finally {
      server.close();
    }
  });

  it('registers same-turn tool-result middleware when the host API exists', async () => {
    const registerAgentToolResultMiddleware = vi.fn();
    registerPlugin(await loadPlugin(), { api: { registerAgentToolResultMiddleware } });
    expect(registerAgentToolResultMiddleware).toHaveBeenCalledTimes(1);
    expect(registerAgentToolResultMiddleware.mock.calls[0][1]).toEqual({ runtimes: ['openclaw'] });
  });

  it('does not register tool-result middleware on the legacy adapter', async () => {
    const registerAgentToolResultMiddleware = vi.fn();
    const plugin = await loadPlugin();
    plugin.register({
      registrationMode: 'full',
      runtime: { version: '2026.3.8' },
      on: () => undefined,
      registerAgentToolResultMiddleware,
    });
    expect(registerAgentToolResultMiddleware).not.toHaveBeenCalled();
  });

  it('fail-opens when middleware registration is rejected by the host', async () => {
    const plugin = await loadPlugin();
    expect(() => registerPlugin(plugin, {
      api: {
        registerAgentToolResultMiddleware: () => {
          throw new Error('only bundled plugins can register agent tool result middleware');
        },
      },
    })).not.toThrow();
  });

  it('middleware fail-opens without throwing when interceptor runtime is missing', async () => {
    const middlewares = [];
    registerPlugin(await loadPlugin(), {
      api: {
        registerAgentToolResultMiddleware: (handler) => {
          middlewares.push(handler);
        },
      },
    });
    await expect(middlewares[0]({
      toolName: 'read',
      toolCallId: 't1',
      result: { content: [{ type: 'text', text: 'ok' }] },
    }, {})).resolves.toBeUndefined();
  });

  it('returns { result } from tool-result middleware when the daemon blocks', async () => {
    const { wrapHostReason } = await import(/* @vite-ignore */ `${INTERCEPTOR_PATH}?mw-plugin=${Date.now()}`);
    const { server, port } = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/health') {
        res.end(JSON.stringify({
          service: 'loongsuite-pilot-interceptor',
          status: 'ok',
          pid: 4242,
          version: '1.0.2',
          daemon_port: port,
        }));
        return;
      }
      res.end(JSON.stringify({
        action: 'block',
        reason: '[DATABASEURL_MASKED]',
        ruleId: 'databaseUrl',
        evaluatedRules: ['databaseUrl'],
      }));
    });
    writeRuntime(port);
    const middlewares = [];
    try {
      registerPlugin(await loadPlugin(), {
        api: {
          registerAgentToolResultMiddleware: (handler, opts) => {
            middlewares.push({ handler, opts });
          },
        },
      });
      expect(middlewares).toHaveLength(1);
      const original = {
        content: [{ type: 'text', text: 'mysql://agent:secret@127.0.0.1:3306/pilot' }],
        details: { status: 'completed' },
      };
      await expect(middlewares[0].handler({
        toolName: 'read',
        toolCallId: 't1',
        args: { path: '/tmp/notes' },
        result: original,
      }, { sessionId: 's1' })).resolves.toEqual({
        result: {
          ...original,
          content: [{ type: 'text', text: wrapHostReason('PostToolUse', '[DATABASEURL_MASKED]') }],
        },
      });
    } finally {
      server.close();
    }
  });

  it('declares the installed-plugin middleware contract', () => {
    const manifestPath = path.resolve(__dirname, '../../../../assets/plugins/openclaw/openclaw.plugin.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.contracts.agentToolResultMiddleware).toEqual(['openclaw']);
  });
});
