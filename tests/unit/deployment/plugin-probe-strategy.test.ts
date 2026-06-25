import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
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

  function createTarball(tarball: string, sourceDir: string): void {
    execFileSync('tar', ['-czf', tarball, '-C', sourceDir, '.'], { stdio: 'ignore' });
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

    it('returns true when source hash matches but worker manifest should be ensured', async () => {
      const tarball = path.join(tmpDir, 'plugin.tar.gz');
      const content = 'same-content';
      const destDir = path.join(tmpDir, 'dest');
      await fs.writeFile(tarball, content);
      await fs.mkdir(path.join(destDir, 'sample-local-runtime-0.1.0'), { recursive: true });
      await fs.writeFile(
        path.join(destDir, 'sample-local-runtime-0.1.0', 'worker.manifest.json'),
        JSON.stringify({
          name: 'sample-worker',
          command: ['scripts/worker-entrypoint.sh'],
          paths: {
            pid: '.agent-worker/runtime/worker.pid',
            status: '.agent-worker/runtime/status.json',
            log: '.agent-worker/runtime/worker.log',
          },
        }),
      );

      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const record: DeployedAgentRecord = {
        deployMode: 'plugin-probe',
        deployedAt: new Date().toISOString(),
        sourceHash: `sha256:${hash}`,
      };

      expect(await strategy.needsDeploy(makeDef({
        pluginProbe: {
          source: { type: 'tar', tarball, destDir },
          mountType: 'wrapper',
        },
      }), record)).toBe(true);
    });

    it('returns false when source hash matches and manifest worker is running', async () => {
      const tarball = path.join(tmpDir, 'plugin.tar.gz');
      const content = 'same-content';
      const destDir = path.join(tmpDir, 'dest');
      const bundleRoot = path.join(destDir, 'sample-local-runtime-0.1.0');
      const pidPath = path.join(bundleRoot, '.agent-worker/runtime/worker.pid');
      await fs.writeFile(tarball, content);
      await fs.mkdir(path.dirname(pidPath), { recursive: true });
      await fs.writeFile(
        path.join(bundleRoot, 'worker.manifest.json'),
        JSON.stringify({
          name: 'sample-worker',
          command: ['scripts/worker-entrypoint.sh'],
          paths: {
            pid: '.agent-worker/runtime/worker.pid',
            status: '.agent-worker/runtime/status.json',
            log: '.agent-worker/runtime/worker.log',
          },
        }),
      );
      await fs.writeFile(pidPath, `${process.pid}\n`, 'utf-8');

      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const record: DeployedAgentRecord = {
        deployMode: 'plugin-probe',
        deployedAt: new Date().toISOString(),
        sourceHash: `sha256:${hash}`,
      };

      expect(await strategy.needsDeploy(makeDef({
        pluginProbe: {
          source: { type: 'tar', tarball, destDir },
          mountType: 'wrapper',
        },
      }), record)).toBe(false);
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

    it('redeploys remote package within interval when manifest worker is not running', async () => {
      const destDir = path.join(tmpDir, 'dest');
      const bundleRoot = path.join(destDir, 'sample-local-runtime-0.1.0');
      const pidPath = path.join(bundleRoot, '.agent-worker/runtime/worker.pid');
      await fs.mkdir(path.dirname(pidPath), { recursive: true });
      await fs.writeFile(
        path.join(bundleRoot, 'worker.manifest.json'),
        JSON.stringify({
          name: 'sample-worker',
          command: ['scripts/worker-entrypoint.sh'],
          paths: {
            pid: '.agent-worker/runtime/worker.pid',
            status: '.agent-worker/runtime/status.json',
            log: '.agent-worker/runtime/worker.log',
          },
        }),
      );
      await fs.writeFile(pidPath, '999999\n', 'utf-8');

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

      expect(await strategy.needsDeploy(def, record)).toBe(true);
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

      createTarball(tarball, destDir);

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

      createTarball(tarball, srcDir);

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

      createTarball(tarball, srcDir);

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

      createTarball(tarball, srcDir);

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

    it('replaces old package files instead of leaving stale files behind', async () => {
      const destDir = path.join(tmpDir, 'dest');
      const tarball = path.join(tmpDir, 'plugin.tar.gz');
      const staleFile = path.join(destDir, 'stale.txt');

      await fs.mkdir(path.join(destDir, 'scripts'), { recursive: true });
      await fs.writeFile(path.join(destDir, 'scripts', 'uninstall.sh'), '#!/bin/bash\nexit 0');
      await fs.writeFile(staleFile, 'old');

      const srcDir = path.join(tmpDir, 'tar-src');
      await fs.mkdir(path.join(srcDir, 'scripts'), { recursive: true });
      await fs.writeFile(path.join(srcDir, 'scripts', 'install.sh'), '#!/bin/bash\nexit 0');
      await fs.writeFile(path.join(srcDir, 'fresh.txt'), 'new');

      createTarball(tarball, srcDir);

      const result = await strategy.deploy(makeDef({
        pluginProbe: {
          source: { type: 'tar', tarball, destDir },
          mountType: 'wrapper',
        },
      }));

      expect(result.success).toBe(true);
      await expect(fs.stat(path.join(destDir, 'fresh.txt'))).resolves.toBeDefined();
      await expect(fs.stat(staleFile)).rejects.toThrow();
    });

    it('restores old package files when package replacement fails', async () => {
      const destDir = path.join(tmpDir, 'dest');
      const tarball = path.join(tmpDir, 'plugin.tar.gz');
      const oldFile = path.join(destDir, 'old.txt');

      await fs.mkdir(destDir, { recursive: true });
      await fs.writeFile(oldFile, 'old');

      const srcDir = path.join(tmpDir, 'tar-src');
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(path.join(srcDir, 'fresh.txt'), 'new');

      createTarball(tarball, srcDir);

      const realRename = (strategy as any).renamePath.bind(strategy);
      const renameSpy = vi.spyOn(strategy as any, 'renamePath').mockImplementation(async (from: string, to: string) => {
        if (String(from).startsWith(path.join(tmpDir, '.dest.staging-')) && String(to) === destDir) {
          const err = new Error('simulated rename failure') as NodeJS.ErrnoException;
          err.code = 'EIO';
          throw err;
        }
        return realRename(from, to);
      });

      try {
        const result = await strategy.deploy(makeDef({
          pluginProbe: {
            source: { type: 'tar', tarball, destDir },
            mountType: 'wrapper',
          },
        }));

        expect(result.success).toBe(false);
        await expect(fs.readFile(oldFile, 'utf-8')).resolves.toBe('old');
        await expect(fs.stat(path.join(destDir, 'fresh.txt'))).rejects.toThrow();
      } finally {
        renameSpy.mockRestore();
      }
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

      createTarball(tarball, srcDir);

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

      createTarball(tarball, srcDir);

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

    it('starts worker from worker.manifest.json after plugin install', async () => {
      const destDir = path.join(tmpDir, 'dest');
      const tarball = path.join(tmpDir, 'plugin.tar.gz');
      const bundleRoot = path.join(destDir, 'sample-local-runtime-0.1.0');
      const envCapture = path.join(tmpDir, 'worker-env.txt');
      const installMarker = path.join(tmpDir, 'install-ran.txt');
      const stateDir = path.join(tmpDir, 'instance-state');
      const logDir = path.join(tmpDir, 'instance-logs');
      const workDir = path.join(tmpDir, 'workspace');

      const srcDir = path.join(tmpDir, 'tar-src', 'sample-local-runtime-0.1.0');
      await fs.mkdir(path.join(srcDir, 'scripts'), { recursive: true });
      await fs.writeFile(path.join(srcDir, 'scripts', 'install.sh'), `#!/bin/bash\ntouch "${installMarker}"\nexit 0`);
      await fs.writeFile(path.join(srcDir, 'scripts', 'uninstall.sh'), '#!/bin/bash\nexit 0');
      await fs.writeFile(
        path.join(srcDir, 'scripts', 'worker-entrypoint.sh'),
        `#!/bin/bash
echo "PLUGIN=$SAMPLE_PLUGIN_DIR"
echo "STATE=$SAMPLE_STATE_DIR"
echo "TOKEN=$(cat "$2")"
echo "WORKDIR=$4"
echo "INSTANCE=$6"
echo "PLUGIN_SCOPE=$8"
echo "MODEL_SCOPE=\${10}"
printf '%s\\n' "$SAMPLE_PLUGIN_DIR" "$SAMPLE_STATE_DIR" "$(cat "$2")" "$4" "$6" "$8" "\${10}" > "${envCapture}"
trap 'exit 0' TERM
while true; do sleep 1; done
`,
      );
      await fs.chmod(path.join(srcDir, 'scripts', 'worker-entrypoint.sh'), 0o755);
      await fs.writeFile(
        path.join(srcDir, 'worker.manifest.json'),
        JSON.stringify({
          name: 'sample-local-worker',
          command: [
            'scripts/worker-entrypoint.sh',
            '--bootstrap-token-file',
            '${instance:bootstrapTokenFile}',
            '--work-dir',
            '${instance:workDir}',
            '--instance-id',
            '${instance:id}',
            '--plugin-install-scope',
            '${instance:pluginInstallScope}',
            '--model-config-mode',
            '${instance:modelConfigMode}',
          ],
          cwd: '.',
          env: {
            SAMPLE_PLUGIN_DIR: '${destDir}/sample-plugin',
            SAMPLE_STATE_DIR: '${instance:stateDir}',
          },
          paths: {
            pid: '${instance:stateDir}/worker.pid',
            status: '${instance:stateDir}/supervisor-status.json',
            log: '${instance:logDir}/worker.log',
          },
          restartPolicy: { type: 'on-failure', maxRestarts: 1, backoffSeconds: 1 },
        }),
      );

      createTarball(tarball, path.join(tmpDir, 'tar-src'));

      const bootstrapTokenFile = path.join(tmpDir, 'credentials', 'bootstrap-token');
      await fs.mkdir(path.dirname(bootstrapTokenFile), { recursive: true });
      await fs.writeFile(bootstrapTokenFile, 'bootstrap-token-1\n', 'utf-8');
      const instance = {
        bootstrapTokenFile,
        workDir,
        id: 'lw_testinstance001',
        stateDir,
        logDir,
      };
      const runtimeOptions = {
        'plugin-install-scope': 'local',
        'model-config-mode': 'managed-runtime',
      };

      const def = makeDef({
        pluginProbe: {
          source: { type: 'tar', tarball, destDir },
          mountType: 'wrapper',
        },
      });

      try {
        const result = await strategy.deploy(def, { instance, runtimeOptions });
        expect(result.success).toBe(true);
        await expect(fs.stat(installMarker)).resolves.toBeDefined();

        const pidPath = path.join(stateDir, 'worker.pid');
        const statusPath = path.join(stateDir, 'supervisor-status.json');
        const logPath = path.join(logDir, 'worker.log');

        const pid = Number.parseInt(await fs.readFile(pidPath, 'utf-8'), 10);
        expect(pid).toBeGreaterThan(0);
        const status = JSON.parse(await fs.readFile(statusPath, 'utf-8')) as { state: string; pid: number };
        expect(status.state).toBe('running');
        expect(status.pid).toBe(pid);

        await vi.waitFor(async () => {
          const captured = (await fs.readFile(envCapture, 'utf-8')).trim().split('\n');
          expect(captured).toEqual([
            path.join(bundleRoot, 'sample-plugin'),
            stateDir,
            'bootstrap-token-1',
            workDir,
            'lw_testinstance001',
            'local',
            'managed-runtime',
          ]);
        });

        await vi.waitFor(async () => {
          const log = await fs.readFile(logPath, 'utf-8');
          expect(log).toContain(`PLUGIN=${path.join(bundleRoot, 'sample-plugin')}`);
        });

        expect(await strategy.stopWorker(def, { instance, runtimeOptions })).toBe(true);
        const stopped = JSON.parse(await fs.readFile(statusPath, 'utf-8')) as { state: string };
        expect(stopped.state).toBe('stopped');
        await expect(fs.stat(pidPath)).rejects.toThrow();
      } finally {
        await strategy.stopWorker(def, { instance, runtimeOptions });
      }
    });

    it('kills remaining worker process group children after graceful stop timeout', async () => {
      const destDir = path.join(tmpDir, 'dest');
      const tarball = path.join(tmpDir, 'plugin.tar.gz');
      const bundleRoot = path.join(destDir, 'sample-local-runtime-0.1.0');
      const childPidFile = path.join(tmpDir, 'child.pid');

      const srcDir = path.join(tmpDir, 'tar-src', 'sample-local-runtime-0.1.0');
      await fs.mkdir(path.join(srcDir, 'scripts'), { recursive: true });
      await fs.writeFile(
        path.join(srcDir, 'scripts', 'worker-entrypoint.sh'),
        `#!/bin/bash
sh -c 'trap "" TERM; while true; do sleep 1; done' &
echo "$!" > "${childPidFile}"
trap 'exit 0' TERM
while true; do sleep 1; done
`,
      );
      await fs.chmod(path.join(srcDir, 'scripts', 'worker-entrypoint.sh'), 0o755);
      await fs.writeFile(
        path.join(srcDir, 'worker.manifest.json'),
        JSON.stringify({
          name: 'sample-local-worker',
          command: ['scripts/worker-entrypoint.sh'],
          paths: {
            pid: '.agent-worker/runtime/claude-code/worker.pid',
            status: '.agent-worker/runtime/claude-code/supervisor-status.json',
            log: '.agent-worker/runtime/claude-code/worker.log',
          },
        }),
      );

      createTarball(tarball, path.join(tmpDir, 'tar-src'));

      const def = makeDef({
        pluginProbe: {
          source: { type: 'tar', tarball, destDir },
          mountType: 'wrapper',
        },
      });

      let childPid: number | undefined;
      try {
        const result = await strategy.deploy(def);
        expect(result.success).toBe(true);

        await vi.waitFor(async () => {
          childPid = Number.parseInt(await fs.readFile(childPidFile, 'utf-8'), 10);
          expect(childPid).toBeGreaterThan(0);
          process.kill(childPid!, 0);
        }, { timeout: 3000 });

        expect(await strategy.stopWorker(def)).toBe(true);
        await vi.waitFor(() => {
          expect(childPid).toBeDefined();
          expect(() => process.kill(childPid!, 0)).toThrow();
        });
      } finally {
        if (childPid) {
          try {
            process.kill(childPid, 'SIGKILL');
          } catch {
            // Process may already be gone.
          }
        }
        await strategy.stopWorker(def);
      }
    });

    it('installs local worker runtime templates without starting worker until an instance exists', async () => {
      const destDir = path.join(tmpDir, 'dest');
      const tarball = path.join(tmpDir, 'plugin.tar.gz');
      const bundleRoot = path.join(destDir, 'sample-local-runtime-0.1.0');
      const installMarker = path.join(tmpDir, 'install-ran.txt');

      const srcDir = path.join(tmpDir, 'tar-src', 'sample-local-runtime-0.1.0');
      await fs.mkdir(path.join(srcDir, 'scripts'), { recursive: true });
      await fs.writeFile(path.join(srcDir, 'scripts', 'install.sh'), `#!/bin/bash\ntouch "${installMarker}"\nexit 0`);
      await fs.writeFile(
        path.join(srcDir, 'worker.manifest.json'),
        JSON.stringify({
          name: 'sample-local-worker',
          command: ['scripts/worker-entrypoint.sh'],
          paths: {
            pid: '${instance:stateDir}/worker.pid',
            status: '${instance:stateDir}/supervisor-status.json',
            log: '${instance:logDir}/worker.log',
          },
        }),
      );

      createTarball(tarball, path.join(tmpDir, 'tar-src'));

      const result = await strategy.deploy(makeDef({
        localWorkerRuntime: 'claude-code',
        pluginProbe: {
          source: { type: 'tar', tarball, destDir },
          mountType: 'wrapper',
        },
      }));

      expect(result.success).toBe(true);
      await expect(fs.stat(installMarker)).resolves.toBeDefined();
      await expect(fs.stat(path.join(bundleRoot, 'worker.pid'))).rejects.toThrow();
      await expect(fs.stat('/worker.log')).rejects.toThrow();
    });

    it('keeps deploy successful when worker manifest command cannot be spawned', async () => {
      const destDir = path.join(tmpDir, 'dest');
      const tarball = path.join(tmpDir, 'plugin.tar.gz');
      const bundleRoot = path.join(destDir, 'sample-local-runtime-0.1.0');

      const srcDir = path.join(tmpDir, 'tar-src', 'sample-local-runtime-0.1.0');
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(
        path.join(srcDir, 'worker.manifest.json'),
        JSON.stringify({
          name: 'sample-local-worker',
          command: ['scripts/missing-worker-entrypoint.sh'],
          paths: {
            pid: '.agent-worker/runtime/claude-code/worker.pid',
            status: '.agent-worker/runtime/claude-code/supervisor-status.json',
            log: '.agent-worker/runtime/claude-code/worker.log',
          },
        }),
      );

      createTarball(tarball, path.join(tmpDir, 'tar-src'));

      const result = await strategy.deploy(makeDef({
        pluginProbe: {
          source: { type: 'tar', tarball, destDir },
          mountType: 'wrapper',
        },
      }));

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();

      const statusPath = path.join(bundleRoot, '.agent-worker/runtime/claude-code/supervisor-status.json');
      const status = JSON.parse(await fs.readFile(statusPath, 'utf-8')) as { state: string; error: string };
      expect(status.state).toBe('failed');
      expect(status.error).toContain('worker process did not expose a pid');
    });

    it('handles worker exit even when the process exits before pid and status writes finish', async () => {
      const destDir = path.join(tmpDir, 'dest');
      const tarball = path.join(tmpDir, 'plugin.tar.gz');
      const bundleRoot = path.join(destDir, 'sample-local-runtime-0.1.0');

      const srcDir = path.join(tmpDir, 'tar-src', 'sample-local-runtime-0.1.0');
      await fs.mkdir(path.join(srcDir, 'scripts'), { recursive: true });
      await fs.writeFile(path.join(srcDir, 'scripts', 'worker-entrypoint.sh'), '#!/bin/bash\nexit 7\n');
      await fs.chmod(path.join(srcDir, 'scripts', 'worker-entrypoint.sh'), 0o755);
      await fs.writeFile(
        path.join(srcDir, 'worker.manifest.json'),
        JSON.stringify({
          name: 'sample-local-worker',
          command: ['scripts/worker-entrypoint.sh'],
          paths: {
            pid: '.agent-worker/runtime/claude-code/worker.pid',
            status: '.agent-worker/runtime/claude-code/supervisor-status.json',
            log: '.agent-worker/runtime/claude-code/worker.log',
          },
          restartPolicy: { type: 'on-failure', maxRestarts: 0, backoffSeconds: 0 },
        }),
      );

      createTarball(tarball, path.join(tmpDir, 'tar-src'));

      const result = await strategy.deploy(makeDef({
        pluginProbe: {
          source: { type: 'tar', tarball, destDir },
          mountType: 'wrapper',
        },
      }));

      expect(result.success).toBe(true);

      const pidPath = path.join(bundleRoot, '.agent-worker/runtime/claude-code/worker.pid');
      const statusPath = path.join(bundleRoot, '.agent-worker/runtime/claude-code/supervisor-status.json');
      await vi.waitFor(async () => {
        const status = JSON.parse(await fs.readFile(statusPath, 'utf-8')) as { state: string; exitCode: number };
        expect(status.state).toBe('exited');
        expect(status.exitCode).toBe(7);
        await expect(fs.stat(pidPath)).rejects.toThrow();
      });
    });

    it('restarts worker when it exits from an unexpected signal', async () => {
      const destDir = path.join(tmpDir, 'dest');
      const tarball = path.join(tmpDir, 'plugin.tar.gz');
      const bundleRoot = path.join(destDir, 'sample-local-runtime-0.1.0');

      const srcDir = path.join(tmpDir, 'tar-src', 'sample-local-runtime-0.1.0');
      await fs.mkdir(path.join(srcDir, 'scripts'), { recursive: true });
      await fs.writeFile(
        path.join(srcDir, 'scripts', 'worker-entrypoint.sh'),
        `#!/bin/bash
trap 'exit 0' TERM
while true; do sleep 1; done
`,
      );
      await fs.chmod(path.join(srcDir, 'scripts', 'worker-entrypoint.sh'), 0o755);
      await fs.writeFile(
        path.join(srcDir, 'worker.manifest.json'),
        JSON.stringify({
          name: 'sample-local-worker',
          command: ['scripts/worker-entrypoint.sh'],
          paths: {
            pid: '.agent-worker/runtime/claude-code/worker.pid',
            status: '.agent-worker/runtime/claude-code/supervisor-status.json',
            log: '.agent-worker/runtime/claude-code/worker.log',
          },
          restartPolicy: { type: 'on-failure', maxRestarts: 1, backoffSeconds: 0 },
        }),
      );

      createTarball(tarball, path.join(tmpDir, 'tar-src'));

      const def = makeDef({
        pluginProbe: {
          source: { type: 'tar', tarball, destDir },
          mountType: 'wrapper',
        },
      });
      const pidPath = path.join(bundleRoot, '.agent-worker/runtime/claude-code/worker.pid');
      const statusPath = path.join(bundleRoot, '.agent-worker/runtime/claude-code/supervisor-status.json');

      try {
        const result = await strategy.deploy(def);
        expect(result.success).toBe(true);

        const firstPid = Number.parseInt(await fs.readFile(pidPath, 'utf-8'), 10);
        process.kill(-firstPid, 'SIGKILL');

        await vi.waitFor(async () => {
          const status = JSON.parse(await fs.readFile(statusPath, 'utf-8')) as {
            state: string;
            pid: number;
            restartCount: number;
          };
          expect(status.state).toBe('running');
          expect(status.restartCount).toBe(1);
          expect(status.pid).not.toBe(firstPid);
        });
      } finally {
        await strategy.undeploy(def);
      }
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
