import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { collectApi } from '../../../../src/pipeline/input/multica/sources.js';
import { entityLabels } from '../../../../src/pipeline/input/multica/entity-labels.js';
import { validateMulticaConfig } from '../../../../src/pipeline/input/multica/types.js';

describe('Multica display metadata', () => {
  it('collects names by default, respects opt-out and never collects entity descriptions or arbitrary metadata', async () => {
    const server = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify([
      {id: 'i-1', identifier: 'OBS-28', title: '排查失败', description: 'private prompt', metadata: {token: 'private-token'}},
    ])); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      vi.stubEnv('MULTICA_LABEL_TEST_TOKEN', 'test-only-token');
      const config = {Type: 'input_multica' as const, TokenEnv: 'MULTICA_LABEL_TEST_TOKEN', ApiBase: `http://127.0.0.1:${(server.address() as {port: number}).port}`};
      const source = {name: 'issues', path: '/', recordType: 'issue_snapshot', workspace: 'w-1'};
      const disabled = await collectApi({...config, CollectEntityNames: false}, source);
      const enabled = await collectApi(config, source);
      expect(disabled.records[0]).not.toHaveProperty('issue_title');
      expect(enabled.records[0]).toMatchObject({issue_id: 'i-1', issue_identifier: 'OBS-28', issue_title: '排查失败'});
      expect(JSON.stringify(enabled)).not.toContain('private');
    } finally { vi.unstubAllEnvs(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('uses runtime custom names, handles blank labels and redacts bounded text', () => {
    expect(entityLabels('runtime_snapshot', {name: 'Claude', custom_name: '开发机'})).toEqual({runtime_name: '开发机'});
    expect(entityLabels('runtime_snapshot', {name: 'Claude', custom_name: ' '})).toEqual({runtime_name: 'Claude'});
    expect(entityLabels('agent_snapshot', {name: 'Bearer secret-value\n' + 'x'.repeat(600)}).agent_name).toHaveLength(512);
    expect(entityLabels('agent_snapshot', {name: 'Bearer secret-value'})).toEqual({agent_name: '[REDACTED]'});
    expect(entityLabels('workspace_snapshot', {name: '', slug: 'acme'})).toEqual({workspace_slug: 'acme'});
    expect(entityLabels('task_snapshot', {title: 'sensitive'})).toEqual({});
    expect(() => validateMulticaConfig({Type: 'input_multica', CollectEntityNames: 'yes' as never})).toThrow('CollectEntityNames');
  });
});
