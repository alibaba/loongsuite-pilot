import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type ConfigFile } from '../../../src/core/config-loader.js';
import { isAgentGatedEnabled } from '../../../src/deployment/deploy-command.js';
import { anyAgentMultimodalEnabled, isAgentMultimodalEnabled } from '../../../src/multimodal/agent-gate.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function slsMultimodal(project: string): NonNullable<ConfigFile['multimodal']> {
  return {
    storage: {
      type: 'sls',
      target: {
        endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
        project,
        logstore: 'multimodal',
      },
      auth: { mode: 'apiKey', apiKey: `${project}-test-key` },
    },
  };
}

describe('managed multimodal configuration', () => {
  let dataDir: string;
  let configPath: string;
  let innerConfigPath: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'pilot-inner-multimodal-'));
    configPath = path.join(dataDir, 'config.json');
    innerConfigPath = path.join(dataDir, 'configs', 'inner', 'data_config.json');
    mkdirSync(path.dirname(innerConfigPath), { recursive: true });
    writeFileSync(configPath, '{}');
    vi.stubEnv('AGENT_DATA_COLLECTION_CONFIG', configPath);
    vi.stubEnv('LOONGSUITE_PILOT_DATA_DIR', dataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('loads SLS apiKey storage from a BOM-prefixed inner config without a user config', async () => {
    unlinkSync(configPath);
    const multimodal = slsMultimodal('managed-project');
    writeFileSync(innerConfigPath, '\uFEFF' + JSON.stringify({ multimodal }));

    const config = await loadConfig();

    expect(config.multimodal).toEqual({
      ...multimodal,
      storageBasePath: 'sls://managed-project/multimodal',
    });
  });

  it.each(['oss', 'delegatedOss'])('reuses the storage parser for managed %s storage', async (type) => {
    const multimodal = type === 'oss'
      ? {
          storage: {
            type,
            target: { endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', storageBasePath: 'oss://bucket/mm' },
            auth: { mode: 'ak', accessKeyId: 'test-ak', accessKeySecret: 'test-sk' },
          },
        }
      : { storage: { ...slsMultimodal('managed').storage, type } };
    writeFileSync(innerConfigPath, JSON.stringify({ multimodal }));

    const config = await loadConfig();

    expect(config.multimodal).toEqual({
      ...multimodal,
      storageBasePath: type === 'oss' ? 'oss://bucket/mm' : 'sls://managed/multimodal',
    });
  });

  it('uses the complete user block over managed storage and leaves both files unchanged', async () => {
    const multimodal = slsMultimodal('user');
    writeFileSync(innerConfigPath, JSON.stringify({ multimodal: slsMultimodal('managed') }));
    writeFileSync(configPath, JSON.stringify({ multimodal }));
    const userBefore = readFileSync(configPath, 'utf8');
    const innerBefore = readFileSync(innerConfigPath, 'utf8');

    const config = await loadConfig();

    expect(config.multimodal).toEqual({ ...multimodal, storageBasePath: 'sls://user/multimodal' });
    expect(readFileSync(configPath, 'utf8')).toBe(userBefore);
    expect(readFileSync(innerConfigPath, 'utf8')).toBe(innerBefore);
  });

  it.each([undefined, {}])('keeps user storage when the managed block is absent: %j', async (inner) => {
    const multimodal = slsMultimodal('user');
    writeFileSync(configPath, JSON.stringify({ multimodal }));
    if (inner !== undefined) writeFileSync(innerConfigPath, JSON.stringify(inner));

    const config = await loadConfig();

    expect(config.multimodal).toEqual({ ...multimodal, storageBasePath: 'sls://user/multimodal' });
  });

  it.each([
    null,
    {},
    { storage: { type: 'sls', target: { endpoint: 'https://managed.log.aliyuncs.com', project: 'managed' } } },
    { storage: { type: 'sls', auth: { mode: 'apiKey', apiKey: 'managed-test-key' } } },
  ])('disables invalid user storage without borrowing managed targets or credentials: %j', async (multimodal) => {
    writeFileSync(configPath, JSON.stringify({ multimodal }));
    writeFileSync(innerConfigPath, JSON.stringify({ multimodal: slsMultimodal('managed') }));

    const config = await loadConfig();

    expect(config.multimodal).toBeUndefined();
  });

  it('uses valid user storage even when managed storage is invalid', async () => {
    const multimodal = slsMultimodal('user');
    writeFileSync(configPath, JSON.stringify({ multimodal }));
    writeFileSync(innerConfigPath, JSON.stringify({ multimodal: { storage: { type: 'unsupported' } } }));

    const config = await loadConfig();

    expect(config.multimodal).toEqual({ ...multimodal, storageBasePath: 'sls://user/multimodal' });
  });

  it('uses managed storage before an otherwise inferred user SLS destination', async () => {
    const multimodal = slsMultimodal('managed');
    writeFileSync(innerConfigPath, JSON.stringify({ multimodal }));
    writeFileSync(configPath, JSON.stringify({
      sls: {
        endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
        project: 'user', logstore: 'events', mode: 'apiKey', apiKey: 'user-test-key',
      },
    }));

    const config = await loadConfig();

    expect(config.multimodal).toEqual({ ...multimodal, storageBasePath: 'sls://managed/multimodal' });
    expect(config.flushers.sls.endpoints[0].project).toBe('user');
  });

  it('retains user SLS shorthand without borrowing managed multimodal credentials', async () => {
    writeFileSync(innerConfigPath, JSON.stringify({ multimodal: slsMultimodal('managed') }));
    writeFileSync(configPath, JSON.stringify({
      sls: {
        endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
        project: 'user', logstore: 'events', mode: 'apiKey', apiKey: 'user-test-key',
      },
      multimodal: { storage: { type: 'sls', target: { logstore: 'images' } } },
    }));

    const config = await loadConfig();

    expect(config.multimodal).toEqual({
      storage: {
        type: 'sls',
        target: { endpoint: 'https://cn-hangzhou.log.aliyuncs.com', project: 'user', logstore: 'images' },
        auth: { mode: 'apiKey', apiKey: 'user-test-key' },
      },
      storageBasePath: 'sls://user/images',
    });
  });

  it('does not infer storage when the user explicitly supplies a null block', async () => {
    writeFileSync(innerConfigPath, JSON.stringify({ multimodal: slsMultimodal('managed') }));
    writeFileSync(configPath, JSON.stringify({
      sls: {
        endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
        project: 'user', logstore: 'events', mode: 'apiKey', apiKey: 'user-test-key',
      },
      multimodal: null,
    }));

    expect((await loadConfig()).multimodal).toBeUndefined();
  });

  it('keeps agent upload policies under user configuration', async () => {
    writeFileSync(innerConfigPath, JSON.stringify({ multimodal: slsMultimodal('managed') }));
    writeFileSync(configPath, JSON.stringify({
      agents: { codex: { multimodal: { uploadMode: 'input' } } },
    }));

    const config = await loadConfig();

    expect(config.multimodal?.storage.type).toBe('sls');
    expect(config.agents.codex.multimodal).toEqual({ uploadMode: 'input' });
    expect(config.agents.qoder?.multimodal).toBeUndefined();
  });

  it('enables managed Codex and Qoder multimodal without changing the default collection gate', async () => {
    writeFileSync(innerConfigPath, JSON.stringify({
      multimodal: slsMultimodal('managed'),
      agents: {
        codex: { multimodal: { uploadMode: 'all' } },
        qoder: { multimodal: { uploadMode: 'all' } },
      },
    }));

    const config = await loadConfig();

    expect(anyAgentMultimodalEnabled(config.agents)).toBe(true);
    for (const agentId of ['codex', 'qoder']) {
      expect(config.agents[agentId].enabled).toBeUndefined();
      expect(isAgentMultimodalEnabled(agentId, config.agents[agentId])).toBe(true);
    }
    for (const agentId of ['codex', 'qoder', 'cursor', 'claude-code']) {
      expect(isAgentGatedEnabled(config, agentId)).toBe(true);
    }
    expect(config.agents.cursor).toBeUndefined();
  });

  it('overrides agent uploadMode by user field while retaining managed roots and other agents', async () => {
    writeFileSync(innerConfigPath, JSON.stringify({
      agents: {
        qoder: { multimodal: { uploadMode: 'all', allowedRootPaths: ['/managed/workspace'] } },
        codex: { multimodal: { uploadMode: 'all' } },
      },
    }));
    writeFileSync(configPath, JSON.stringify({
      agents: { qoder: { multimodal: { uploadMode: 'input' } } },
    }));

    const config = await loadConfig();

    expect(config.agents.qoder.multimodal).toEqual({
      uploadMode: 'input', allowedRootPaths: ['/managed/workspace'],
    });
    expect(config.agents.codex.multimodal).toEqual({ uploadMode: 'all' });
  });

  it('allows user uploadMode=none to disable managed multimodal without disabling collection', async () => {
    writeFileSync(innerConfigPath, JSON.stringify({
      agents: { qoder: { multimodal: { uploadMode: 'all' } } },
    }));
    writeFileSync(configPath, JSON.stringify({
      agents: { qoder: { multimodal: { uploadMode: 'none' } } },
    }));

    const config = await loadConfig();

    expect(isAgentMultimodalEnabled('qoder', config.agents.qoder)).toBe(false);
    expect(isAgentGatedEnabled(config, 'qoder')).toBe(true);
    expect(isAgentGatedEnabled(config, 'cursor')).toBe(true);
  });

  it.each([
    [['/user/workspace'], ['/user/workspace']],
    [[], undefined],
  ])('user roots replace the managed extra roots: %j', async (roots, expected) => {
    writeFileSync(innerConfigPath, JSON.stringify({
      agents: { qoder: { multimodal: { uploadMode: 'all', allowedRootPaths: ['/managed/workspace'] } } },
    }));
    writeFileSync(configPath, JSON.stringify({
      agents: { qoder: { multimodal: { allowedRootPaths: roots } } },
    }));

    const config = await loadConfig();

    expect(config.agents.qoder.multimodal?.uploadMode).toBe('all');
    expect(config.agents.qoder.multimodal?.allowedRootPaths).toEqual(expected);
  });

  it('preserves user enabled=false and captureMessageContent=false over internal defaults', async () => {
    writeFileSync(innerConfigPath, JSON.stringify({
      agents: {
        qoder: { enabled: true, multimodal: { uploadMode: 'all' } },
        codex: { captureMessageContent: true, multimodal: { uploadMode: 'all' } },
      },
    }));
    writeFileSync(configPath, JSON.stringify({
      agents: { qoder: { enabled: false }, codex: { captureMessageContent: false } },
    }));

    const config = await loadConfig();

    expect(isAgentGatedEnabled(config, 'qoder')).toBe(false);
    expect(isAgentGatedEnabled(config, 'cursor')).toBe(true);
    expect(config.agents.codex.captureMessageContent).toBe(false);
    expect(isAgentMultimodalEnabled('codex', config.agents.codex)).toBe(false);
  });
});
