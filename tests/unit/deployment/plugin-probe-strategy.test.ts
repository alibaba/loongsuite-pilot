import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { PluginProbeStrategy } from '../../../src/deployment/plugin-probe-strategy.js';
import type { AgentDefinition, DeployedAgentRecord } from '../../../src/types/index.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/deployment/detect-utils.js', () => ({
  detectAgent: vi.fn(),
}));

import { detectAgent } from '../../../src/deployment/detect-utils.js';

describe('PluginProbeStrategy', () => {
  let tmpDir: string;
  let dataDir: string;
  let pilotDir: string;
  let strategy: PluginProbeStrategy;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-probe-'));
    dataDir = path.join(tmpDir, 'data');
    pilotDir = path.join(tmpDir, 'pilot');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(pilotDir, { recursive: true });
    strategy = new PluginProbeStrategy(dataDir, pilotDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeDef(overrides?: Partial<AgentDefinition>): AgentDefinition {
    return {
      id: 'test-plugin',
      displayName: 'Test Plugin',
      deployMode: 'plugin-probe',
      detection: { paths: ['/home/.test'], commands: [] },
      pluginProbe: {
        source: {
          type: 'tar',
          tarball: path.join(tmpDir, 'plugin.tar.gz'),
          destDir: path.join(tmpDir, 'dest'),
        },
        mountType: 'wrapper',
      },
      ...overrides,
    };
  }

  describe('detect', () => {
    it('delegates to detectAgent', async () => {
      vi.mocked(detectAgent).mockResolvedValue(true);
      const def = makeDef();
      expect(await strategy.detect(def)).toBe(true);
      expect(detectAgent).toHaveBeenCalledWith(def.detection);
    });
  });

  describe('needsDeploy', () => {
    it('returns true when no record exists', async () => {
      expect(await strategy.needsDeploy(makeDef())).toBe(true);
    });

    it('returns true when pluginProbe config is missing', async () => {
      const def = makeDef({ pluginProbe: undefined });
      const record: DeployedAgentRecord = {
        deployMode: 'plugin-probe',
        deployedAt: new Date().toISOString(),
        sourceHash: 'sha256:abc',
      };
      expect(await strategy.needsDeploy(def, record)).toBe(true);
    });

    it('returns true when source hash differs', async () => {
      const tarball = path.join(tmpDir, 'plugin.tar.gz');
      await fs.writeFile(tarball, 'new-content');

      const hash = crypto.createHash('sha256').update('old-content').digest('hex');
      const record: DeployedAgentRecord = {
        deployMode: 'plugin-probe',
        deployedAt: new Date().toISOString(),
        sourceHash: `sha256:${hash}`,
      };

      expect(await strategy.needsDeploy(makeDef(), record)).toBe(true);
    });

    it('returns false when source hash matches', async () => {
      const tarball = path.join(tmpDir, 'plugin.tar.gz');
      const content = 'same-content';
      await fs.writeFile(tarball, content);
      await fs.mkdir(path.join(tmpDir, 'dest'), { recursive: true });

      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const record: DeployedAgentRecord = {
        deployMode: 'plugin-probe',
        deployedAt: new Date().toISOString(),
        sourceHash: `sha256:${hash}`,
      };

      expect(await strategy.needsDeploy(makeDef(), record)).toBe(false);
    });

    it('returns true when destDir is missing even if hash matches', async () => {
      const tarball = path.join(tmpDir, 'plugin.tar.gz');
      const content = 'same-content';
      await fs.writeFile(tarball, content);

      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const record: DeployedAgentRecord = {
        deployMode: 'plugin-probe',
        deployedAt: new Date().toISOString(),
        sourceHash: `sha256:${hash}`,
      };

      // destDir does not exist → needsDeploy should return true
      expect(await strategy.needsDeploy(makeDef(), record)).toBe(true);
    });

    it('returns true when tarball does not exist', async () => {
      const record: DeployedAgentRecord = {
        deployMode: 'plugin-probe',
        deployedAt: new Date().toISOString(),
        sourceHash: 'sha256:abc',
      };
      expect(await strategy.needsDeploy(makeDef(), record)).toBe(true);
    });
  });

  describe('computeSourceHash', () => {
    it('returns sha256 hash for existing file', async () => {
      const filePath = path.join(tmpDir, 'file.tar.gz');
      await fs.writeFile(filePath, 'hello');

      const expected = `sha256:${crypto.createHash('sha256').update('hello').digest('hex')}`;
      const result = await strategy.computeSourceHash(filePath);
      expect(result).toBe(expected);
    });

    it('returns undefined for non-existent file', async () => {
      const result = await strategy.computeSourceHash(path.join(tmpDir, 'missing.tar.gz'));
      expect(result).toBeUndefined();
    });

    it('returns undefined when no source provided', async () => {
      const result = await strategy.computeSourceHash(undefined, undefined);
      expect(result).toBeUndefined();
    });
  });

  describe('isRemoteOnly', () => {
    it('returns true when only url is set', () => {
      expect(strategy.isRemoteOnly({ url: 'https://example.com/p.tar.gz', destDir: '/d' })).toBe(true);
    });

    it('returns true when only remoteUrl is set', () => {
      expect(strategy.isRemoteOnly({ remoteUrl: 'https://example.com/p.tar.gz', destDir: '/d' })).toBe(true);
    });

    it('returns false when tarball is set', () => {
      expect(strategy.isRemoteOnly({ tarball: '/local/p.tar.gz', remoteUrl: 'https://example.com/p.tar.gz', destDir: '/d' })).toBe(false);
    });

    it('returns false when neither url nor remoteUrl is set', () => {
      expect(strategy.isRemoteOnly({ destDir: '/d' })).toBe(false);
    });
  });

  describe('isRemoteCheckDue', () => {
    it('returns true when lastRemoteCheckedAt is absent', () => {
      const record: DeployedAgentRecord = {
        deployMode: 'plugin-probe',
        deployedAt: new Date().toISOString(),
      };
      expect(strategy.isRemoteCheckDue(record)).toBe(true);
    });

    it('returns false when checked less than 4 hours ago', () => {
      const record: DeployedAgentRecord = {
        deployMode: 'plugin-probe',
        deployedAt: new Date().toISOString(),
        lastRemoteCheckedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
      };
      expect(strategy.isRemoteCheckDue(record)).toBe(false);
    });

    it('returns true when checked more than 4 hours ago', () => {
      const record: DeployedAgentRecord = {
        deployMode: 'plugin-probe',
        deployedAt: new Date().toISOString(),
        lastRemoteCheckedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(), // 5h ago
      };
      expect(strategy.isRemoteCheckDue(record)).toBe(true);
    });
  });

  describe('needsDeploy with remote interval guard', () => {
    it('skips remote check when within 4h interval', async () => {
      const destDir = path.join(tmpDir, 'dest');
      await fs.mkdir(destDir, { recursive: true });

      const def = makeDef({
        pluginProbe: {
          source: {
            type: 'oss',
            url: 'https://example.com/plugin.tar.gz',
            destDir,
          },
          mountType: 'wrapper',
        },
      });
      delete (def.pluginProbe!.source as any).tarball;

      const record: DeployedAgentRecord = {
        deployMode: 'plugin-probe',
        deployedAt: new Date().toISOString(),
        sourceHash: 'sha256:abc',
        lastRemoteCheckedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      };

      expect(await strategy.needsDeploy(def, record)).toBe(false);
    });

    it('performs remote check when past 4h interval', async () => {
      const destDir = path.join(tmpDir, 'dest');
      await fs.mkdir(destDir, { recursive: true });

      const tarball = path.join(tmpDir, 'plugin.tar.gz');
      await fs.writeFile(tarball, 'content');
      const hash = crypto.createHash('sha256').update('content').digest('hex');

      const def = makeDef({
        pluginProbe: {
          source: {
            type: 'tar',
            tarball,
            destDir,
          },
          mountType: 'wrapper',
        },
      });

      const record: DeployedAgentRecord = {
        deployMode: 'plugin-probe',
        deployedAt: new Date().toISOString(),
        sourceHash: `sha256:${hash}`,
        lastRemoteCheckedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
      };

      expect(await strategy.needsDeploy(def, record)).toBe(false);
    });

    it('always checks local tarball regardless of interval', async () => {
      const tarball = path.join(tmpDir, 'plugin.tar.gz');
      await fs.writeFile(tarball, 'new-content');

      const oldHash = crypto.createHash('sha256').update('old-content').digest('hex');

      const def = makeDef({
        pluginProbe: {
          source: {
            type: 'tar',
            tarball,
            destDir: path.join(tmpDir, 'dest'),
          },
          mountType: 'wrapper',
        },
      });

      const record: DeployedAgentRecord = {
        deployMode: 'plugin-probe',
        deployedAt: new Date().toISOString(),
        sourceHash: `sha256:${oldHash}`,
        lastRemoteCheckedAt: new Date().toISOString(), // just checked
      };

      // Local tarball changed → needsDeploy should be true, interval guard doesn't apply
      expect(await strategy.needsDeploy(def, record)).toBe(true);
    });
  });

  describe('deploy', () => {
    it('returns error when pluginProbe config is missing', async () => {
      const def = makeDef({ pluginProbe: undefined });
      const result = await strategy.deploy(def);
      expect(result.success).toBe(false);
      expect(result.error).toBe('missing pluginProbe config');
    });

    it('extracts tarball and runs convention install script', async () => {
      const destDir = path.join(tmpDir, 'dest');
      const tarball = path.join(tmpDir, 'plugin.tar.gz');

      // Create a tarball with scripts/install.sh
      await fs.mkdir(path.join(destDir, 'scripts'), { recursive: true });
      await fs.writeFile(path.join(destDir, 'scripts', 'install.sh'), '#!/bin/bash\nexit 0');

      const { execSync } = await import('node:child_process');
      execSync(`tar -czf "${tarball}" -C "${destDir}" .`, { stdio: 'ignore' });

      const def = makeDef({
        pluginProbe: {
          source: { type: 'tar', tarball, destDir },
          mountType: 'wrapper',
        },
      });

      const result = await strategy.deploy(def);
      expect(result.success).toBe(true);
      expect(result.agentId).toBe('test-plugin');
    });

    it('prefers pilot wrapper script over plugin install.sh', async () => {
      const destDir = path.join(tmpDir, 'dest');
      const tarball = path.join(tmpDir, 'plugin.tar.gz');

      // Create tarball with a plugin install.sh that fails
      const srcDir = path.join(tmpDir, 'tar-src');
      await fs.mkdir(path.join(srcDir, 'scripts'), { recursive: true });
      await fs.writeFile(path.join(srcDir, 'scripts', 'install.sh'), '#!/bin/bash\nexit 1');

      const { execSync } = await import('node:child_process');
      execSync(`tar -czf "${tarball}" -C "${srcDir}" .`, { stdio: 'ignore' });

      // Create pilot wrapper that succeeds
      const wrapperDir = path.join(pilotDir, 'scripts');
      await fs.mkdir(wrapperDir, { recursive: true });
      await fs.writeFile(path.join(wrapperDir, 'plugin-install-test-plugin.sh'), '#!/bin/bash\nexit 0');

      const def = makeDef({
        pluginProbe: {
          source: { type: 'tar', tarball, destDir },
          mountType: 'wrapper',
        },
      });

      const result = await strategy.deploy(def);
      expect(result.success).toBe(true);
    });

    it('passes environment variables to install script', async () => {
      const destDir = path.join(tmpDir, 'dest');
      const tarball = path.join(tmpDir, 'plugin.tar.gz');
      const envFile = path.join(tmpDir, 'env-check.txt');

      const srcDir = path.join(tmpDir, 'tar-src');
      await fs.mkdir(path.join(srcDir, 'scripts'), { recursive: true });
      await fs.writeFile(
        path.join(srcDir, 'scripts', 'install.sh'),
        `#!/bin/bash\necho "DATA=$PILOT_DATA_DIR LOG=$PILOT_LOG_DIR NODE=$PILOT_NODE_BIN" > "${envFile}"\nexit 0`,
      );

      const { execSync } = await import('node:child_process');
      execSync(`tar -czf "${tarball}" -C "${srcDir}" .`, { stdio: 'ignore' });

      const def = makeDef({
        pluginProbe: {
          source: { type: 'tar', tarball, destDir },
          mountType: 'wrapper',
        },
      });

      await strategy.deploy(def);

      const envContent = await fs.readFile(envFile, 'utf-8');
      expect(envContent).toContain(`DATA=${dataDir}`);
      expect(envContent).toContain(`LOG=${path.join(dataDir, 'logs', 'test-plugin')}`);
      expect(envContent).toContain(`NODE=${process.execPath}`);
    });

    it('runs uninstall script before update when present', async () => {
      const destDir = path.join(tmpDir, 'dest');
      const tarball = path.join(tmpDir, 'plugin.tar.gz');
      const uninstallMarker = path.join(tmpDir, 'uninstalled.txt');

      // Pre-populate destDir with an uninstall script (simulating existing install)
      await fs.mkdir(path.join(destDir, 'scripts'), { recursive: true });
      await fs.writeFile(
        path.join(destDir, 'scripts', 'uninstall.sh'),
        `#!/bin/bash\ntouch "${uninstallMarker}"\nexit 0`,
      );

      // Create new tarball from a separate directory
      const srcDir = path.join(tmpDir, 'tar-src');
      await fs.mkdir(path.join(srcDir, 'scripts'), { recursive: true });
      await fs.writeFile(path.join(srcDir, 'scripts', 'install.sh'), '#!/bin/bash\nexit 0');

      const { execSync } = await import('node:child_process');
      execSync(`tar -czf "${tarball}" -C "${srcDir}" .`, { stdio: 'ignore' });

      const def = makeDef({
        pluginProbe: {
          source: { type: 'tar', tarball, destDir },
          mountType: 'wrapper',
        },
      });

      const result = await strategy.deploy(def);
      expect(result.success).toBe(true);

      // Verify uninstall was called
      const exists = await fs.stat(uninstallMarker).then(() => true, () => false);
      expect(exists).toBe(true);
    });

    it('returns failure when tarball does not exist and no remote URL', async () => {
      const def = makeDef({
        pluginProbe: {
          source: {
            type: 'tar',
            tarball: path.join(tmpDir, 'nonexistent.tar.gz'),
            destDir: path.join(tmpDir, 'dest'),
          },
          mountType: 'wrapper',
        },
      });

      const result = await strategy.deploy(def);
      expect(result.success).toBe(false);
    });

    it('succeeds without install script', async () => {
      const destDir = path.join(tmpDir, 'dest');
      const tarball = path.join(tmpDir, 'plugin.tar.gz');

      const srcDir = path.join(tmpDir, 'tar-src');
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(path.join(srcDir, 'data.txt'), 'test');

      const { execSync } = await import('node:child_process');
      execSync(`tar -czf "${tarball}" -C "${srcDir}" .`, { stdio: 'ignore' });

      const def = makeDef({
        pluginProbe: {
          source: { type: 'tar', tarball, destDir },
          mountType: 'wrapper',
        },
      });

      const result = await strategy.deploy(def);
      expect(result.success).toBe(true);
    });

    it('returns failure when install script exits non-zero', async () => {
      const destDir = path.join(tmpDir, 'dest');
      const tarball = path.join(tmpDir, 'plugin.tar.gz');

      const srcDir = path.join(tmpDir, 'tar-src');
      await fs.mkdir(path.join(srcDir, 'scripts'), { recursive: true });
      await fs.writeFile(path.join(srcDir, 'scripts', 'install.sh'), '#!/bin/bash\nexit 1');

      const { execSync } = await import('node:child_process');
      execSync(`tar -czf "${tarball}" -C "${srcDir}" .`, { stdio: 'ignore' });

      const def = makeDef({
        pluginProbe: {
          source: { type: 'tar', tarball, destDir },
          mountType: 'wrapper',
        },
      });

      const result = await strategy.deploy(def);
      expect(result.success).toBe(false);
      expect(result.error).toBe('install script failed');
    });
  });

  describe('undeploy', () => {
    it('runs uninstall script when present', async () => {
      const destDir = path.join(tmpDir, 'dest');
      const marker = path.join(tmpDir, 'uninstalled.txt');

      await fs.mkdir(path.join(destDir, 'scripts'), { recursive: true });
      await fs.writeFile(
        path.join(destDir, 'scripts', 'uninstall.sh'),
        `#!/bin/bash\ntouch "${marker}"\nexit 0`,
      );

      const def = makeDef({
        pluginProbe: {
          source: { type: 'tar', destDir },
          mountType: 'wrapper',
        },
      });

      const result = await strategy.undeploy(def);
      expect(result).toBe(true);

      const exists = await fs.stat(marker).then(() => true, () => false);
      expect(exists).toBe(true);
    });

    it('returns false when no uninstall script', async () => {
      const destDir = path.join(tmpDir, 'dest');
      await fs.mkdir(destDir, { recursive: true });

      const def = makeDef({
        pluginProbe: {
          source: { type: 'tar', destDir },
          mountType: 'wrapper',
        },
      });

      expect(await strategy.undeploy(def)).toBe(false);
    });

    it('returns false when no pluginProbe config', async () => {
      const def = makeDef({ pluginProbe: undefined });
      expect(await strategy.undeploy(def)).toBe(false);
    });
  });
});
