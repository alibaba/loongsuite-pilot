import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { AgentDefinition } from '../../../src/types/index.js';
import { LocalWorkerActivationService } from '../../../src/local-workers/local-worker-activation-service.js';
import { bootstrapTokenPath, connectLocalWorker, logDir, stateDir } from '../../../src/local-workers/instance-store.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('LocalWorkerActivationService', () => {
  let tmpDir: string;
  let dataDir: string;
  let pilotDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-worker-activation-'));
    dataDir = path.join(tmpDir, 'data');
    pilotDir = path.join(tmpDir, 'pilot');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(pilotDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function token(): string {
    return Buffer.from(JSON.stringify({
      workerUuid: '550e8400-e29b-41d4-a716-446655440000',
      matrixUrl: 'https://matrix.example.com',
      controllerUrl: 'https://controller.example.com',
      modelGatewayUrl: 'https://model.example.com',
    })).toString('base64');
  }

  async function makeBundle(
    tarball: string,
    captureFile: string,
    installMarker: string,
    entrypoint = `#!/bin/bash
printf '%s\\n' "$PWD" "$2" "$(cat "$2")" "$4" "$6" "$8" "\${10}" "$SAMPLE_STATE_DIR" "$SAMPLE_PLUGIN_DIR" > "${captureFile}"
trap 'exit 0' TERM
while true; do sleep 1; done
`,
    restartPolicy: Record<string, unknown> = { type: 'on-failure', maxRestarts: 1, backoffSeconds: 0 },
    manifestPaths: Record<string, string> = {
      pid: '${instance:stateDir}/worker.pid',
      status: '${instance:stateDir}/supervisor-status.json',
      log: '${instance:logDir}/worker.log',
    },
  ): Promise<void> {
    const bundleRoot = path.join(tmpDir, 'bundle-src', 'sample-local-runtime-0.1.0');
    await fs.mkdir(path.join(bundleRoot, 'scripts'), { recursive: true });
    await fs.mkdir(path.join(bundleRoot, 'sample-plugin'), { recursive: true });
    await fs.writeFile(
      path.join(bundleRoot, 'scripts', 'install.sh'),
      `#!/bin/bash\ntouch "${installMarker}"\nexit 0`,
      'utf-8',
    );
    await fs.writeFile(path.join(bundleRoot, 'scripts', 'uninstall.sh'), '#!/bin/bash\nexit 0\n', 'utf-8');
    await fs.writeFile(
      path.join(bundleRoot, 'scripts', 'worker-entrypoint.sh'),
      entrypoint,
      'utf-8',
    );
    await fs.chmod(path.join(bundleRoot, 'scripts', 'worker-entrypoint.sh'), 0o755);
    await fs.writeFile(
      path.join(bundleRoot, 'worker.manifest.json'),
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
        paths: manifestPaths,
        restartPolicy,
      }),
      'utf-8',
    );

    execSync(`tar -czf "${tarball}" -C "${path.join(tmpDir, 'bundle-src')}" .`, { stdio: 'ignore' });
  }

  it('hot-starts a connected local worker from the runtime template', async () => {
    const tarball = path.join(tmpDir, 'sample-local-runtime-0.0.1.tar.gz');
    const captureFile = path.join(tmpDir, 'worker-capture.txt');
    const installMarker = path.join(tmpDir, 'install-ran');
    await makeBundle(tarball, captureFile, installMarker);

    const workDir = path.join(tmpDir, 'project');
    const instance = await connectLocalWorker({
      dataDir,
      runtime: 'claude-code',
      bootstrapToken: token(),
      workDir,
      runtimeOptions: { 'plugin-install-scope': 'global', 'model-config-mode': 'managed-global' },
    });

    const template: AgentDefinition = {
      id: 'sample-local-runtime-template',
      displayName: 'Sample Local Runtime',
      deployMode: 'plugin-probe',
      localWorkerRuntime: 'claude-code',
      detection: { paths: [], commands: [] },
      pluginProbe: {
        source: {
          type: 'tar',
          tarball,
          destDir: path.join(tmpDir, 'unused-template-cache'),
        },
        mountType: 'wrapper',
      },
    };
    const service = new LocalWorkerActivationService({ dataDir, pilotDir, definitions: [template] });

    try {
      await service.start();
      await vi.waitFor(async () => {
        const captured = (await fs.readFile(captureFile, 'utf-8')).trim().split('\n');
        const bundleRoot = path.join(dataDir, 'local-workers', instance.id, 'bundle', 'sample-local-runtime-0.1.0');
        const bundleRootReal = await fs.realpath(bundleRoot);
        expect(captured).toEqual([
          bundleRootReal,
          bootstrapTokenPath(dataDir, instance),
          token(),
          workDir,
          instance.id,
          'global',
          'managed-global',
          stateDir(dataDir, instance.id),
          path.join(bundleRoot, 'sample-plugin'),
        ]);
      });

      await expect(fs.stat(installMarker)).resolves.toBeDefined();
      const status = JSON.parse(
        await fs.readFile(path.join(stateDir(dataDir, instance.id), 'supervisor-status.json'), 'utf-8'),
      ) as { state: string; pid: number };
      expect(status.state).toBe('running');
      expect(status.pid).toBeGreaterThan(0);
      await expect(fs.stat(path.join(logDir(dataDir, instance.id), 'worker.log'))).resolves.toBeDefined();
    } finally {
      await service.stop();
    }
  });

  it('restarts a running local worker when the local bundle tarball changes', async () => {
    const tarball = path.join(tmpDir, 'sample-local-runtime-0.0.1.tar.gz');
    const captureFile = path.join(tmpDir, 'worker-version.txt');
    const installMarker = path.join(tmpDir, 'install-ran');
    const entrypoint = (version: string) => `#!/bin/bash
printf '%s\\n' "${version}" "$2" "$(cat "$2")" "$6" > "${captureFile}"
trap 'exit 0' TERM
while true; do sleep 1; done
`;
    await makeBundle(tarball, captureFile, installMarker, entrypoint('v1'));

    const instance = await connectLocalWorker({
      dataDir,
      runtime: 'claude-code',
      bootstrapToken: token(),
      workDir: path.join(tmpDir, 'project'),
    });

    const template: AgentDefinition = {
      id: 'sample-local-runtime-template',
      displayName: 'Sample Local Runtime',
      deployMode: 'plugin-probe',
      localWorkerRuntime: 'claude-code',
      detection: { paths: [], commands: [] },
      pluginProbe: {
        source: {
          type: 'tar',
          tarball,
          destDir: path.join(tmpDir, 'unused-template-cache'),
        },
        mountType: 'wrapper',
      },
    };
    const service = new LocalWorkerActivationService({ dataDir, pilotDir, definitions: [template] });

    try {
      await service.start();
      await vi.waitFor(async () => {
        expect((await fs.readFile(captureFile, 'utf-8')).trim().split('\n')).toEqual([
          'v1',
          bootstrapTokenPath(dataDir, instance),
          token(),
          instance.id,
        ]);
      });

      await makeBundle(tarball, captureFile, installMarker, entrypoint('v2'));
      await service.refresh('bundle-change');
      await vi.waitFor(async () => {
        expect((await fs.readFile(captureFile, 'utf-8')).trim().split('\n')).toEqual([
          'v2',
          bootstrapTokenPath(dataDir, instance),
          token(),
          instance.id,
        ]);
      });
    } finally {
      await service.stop();
    }
  });

  it('does not restart a running worker when only the bootstrap token file changes', async () => {
    const tarball = path.join(tmpDir, 'sample-local-runtime-0.0.1.tar.gz');
    const captureFile = path.join(tmpDir, 'worker-runs.txt');
    const installMarker = path.join(tmpDir, 'install-ran');
    const entrypoint = `#!/bin/bash
printf '%s\\n' "$(cat "$2")" >> "${captureFile}"
trap 'exit 0' TERM
while true; do sleep 1; done
`;
    await makeBundle(tarball, captureFile, installMarker, entrypoint);

    const instance = await connectLocalWorker({
      dataDir,
      runtime: 'claude-code',
      bootstrapToken: token(),
      workDir: path.join(tmpDir, 'project'),
    });

    const template: AgentDefinition = {
      id: 'sample-local-runtime-template',
      displayName: 'Sample Local Runtime',
      deployMode: 'plugin-probe',
      localWorkerRuntime: 'claude-code',
      detection: { paths: [], commands: [] },
      pluginProbe: {
        source: {
          type: 'tar',
          tarball,
          destDir: path.join(tmpDir, 'unused-template-cache'),
        },
        mountType: 'wrapper',
      },
    };
    const service = new LocalWorkerActivationService({ dataDir, pilotDir, definitions: [template] });

    try {
      await service.start();
      await vi.waitFor(async () => {
        expect((await fs.readFile(captureFile, 'utf-8')).trim().split('\n')).toEqual([token()]);
      });

      await fs.writeFile(bootstrapTokenPath(dataDir, instance), `${Buffer.from(JSON.stringify({
        workerUuid: '550e8400-e29b-41d4-a716-446655440000',
        matrixUrl: 'https://matrix-2.example.com',
        controllerUrl: 'https://controller-2.example.com',
        modelGatewayUrl: 'https://model-2.example.com',
      })).toString('base64')}\n`, 'utf-8');
      await service.refresh('token-rotation');

      expect((await fs.readFile(captureFile, 'utf-8')).trim().split('\n')).toEqual([token()]);
    } finally {
      await service.stop();
    }
  });

  it('does not restart a same-fingerprint worker whose pid path is defined by the manifest', async () => {
    const tarball = path.join(tmpDir, 'sample-local-runtime-0.0.1.tar.gz');
    const captureFile = path.join(tmpDir, 'worker-runs.txt');
    const installMarker = path.join(tmpDir, 'install-ran');
    const entrypoint = `#!/bin/bash
printf 'run\\n' >> "${captureFile}"
trap 'exit 0' TERM
while true; do sleep 1; done
`;
    await makeBundle(
      tarball,
      captureFile,
      installMarker,
      entrypoint,
      { type: 'on-failure', maxRestarts: 1, backoffSeconds: 0 },
      {
        pid: '.agent-worker/custom/worker.pid',
        status: '${instance:stateDir}/supervisor-status.json',
        log: '${instance:logDir}/worker.log',
      },
    );

    await connectLocalWorker({
      dataDir,
      runtime: 'claude-code',
      bootstrapToken: token(),
      workDir: path.join(tmpDir, 'project'),
    });

    const template: AgentDefinition = {
      id: 'sample-local-runtime-template',
      displayName: 'Sample Local Runtime',
      deployMode: 'plugin-probe',
      localWorkerRuntime: 'claude-code',
      detection: { paths: [], commands: [] },
      pluginProbe: {
        source: {
          type: 'tar',
          tarball,
          destDir: path.join(tmpDir, 'unused-template-cache'),
        },
        mountType: 'wrapper',
      },
    };
    const service = new LocalWorkerActivationService({ dataDir, pilotDir, definitions: [template] });

    try {
      await service.start();
      await vi.waitFor(async () => {
        expect((await fs.readFile(captureFile, 'utf-8')).trim().split('\n')).toEqual(['run']);
      });

      await service.refresh('same-fingerprint');
      await new Promise(resolve => setTimeout(resolve, 250));

      expect((await fs.readFile(captureFile, 'utf-8')).trim().split('\n')).toEqual(['run']);
    } finally {
      await service.stop();
    }
  });

  it('restarts a same-fingerprint instance when the worker process is no longer alive', async () => {
    const tarball = path.join(tmpDir, 'sample-local-runtime-0.0.1.tar.gz');
    const captureFile = path.join(tmpDir, 'worker-runs.txt');
    const installMarker = path.join(tmpDir, 'install-ran');
    await makeBundle(
      tarball,
      captureFile,
      installMarker,
      `#!/bin/bash\nprintf 'run\\n' >> "${captureFile}"\nexit 7\n`,
      { type: 'on-failure', maxRestarts: 0, backoffSeconds: 0 },
    );

    await connectLocalWorker({
      dataDir,
      runtime: 'claude-code',
      bootstrapToken: token(),
      workDir: path.join(tmpDir, 'project'),
    });

    const template: AgentDefinition = {
      id: 'sample-local-runtime-template',
      displayName: 'Sample Local Runtime',
      deployMode: 'plugin-probe',
      localWorkerRuntime: 'claude-code',
      detection: { paths: [], commands: [] },
      pluginProbe: {
        source: {
          type: 'tar',
          tarball,
          destDir: path.join(tmpDir, 'unused-template-cache'),
        },
        mountType: 'wrapper',
      },
    };
    const service = new LocalWorkerActivationService({ dataDir, pilotDir, definitions: [template] });

    try {
      await service.refresh('test');
      await vi.waitFor(async () => {
        const runs = (await fs.readFile(captureFile, 'utf-8')).trim().split('\n');
        expect(runs).toHaveLength(1);
      });

      await service.refresh('test');

      await vi.waitFor(async () => {
        const runs = (await fs.readFile(captureFile, 'utf-8')).trim().split('\n');
        expect(runs.length).toBeGreaterThanOrEqual(2);
      });
    } finally {
      await service.stop();
    }
  });
});
