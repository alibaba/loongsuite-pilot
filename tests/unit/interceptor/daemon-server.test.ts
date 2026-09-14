import { describe, expect, it } from 'vitest';
import { createInterceptorServer } from '../../../src/interceptor/daemon/server.js';
import { RuleEngine } from '../../../src/interceptor/rules/engine.js';
import { INTERCEPTOR_SERVICE, type LocalRule } from '../../../src/interceptor/types.js';

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
  it('serves health and evaluates hooks', async () => {
    const rule: LocalRule = {
      id: 'demo',
      supports: () => true,
      evaluate: async () => ({ matched: true, reason: 'blocked by demo' }),
    };
    const opts = {
      port: 0,
      version: '1.2.3',
      engine: new RuleEngine([rule], { demo: true }),
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

      const blocked = await fetch(`http://127.0.0.1:${port}/v1/hooks/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: 'qoder',
          event: 'UserPromptSubmit',
          raw: {},
        }),
      });
      await expect(blocked.json()).resolves.toMatchObject({
        action: 'block',
        reason: 'blocked by demo',
        ruleId: 'demo',
      });
    } finally {
      server.close();
    }
  });
});
