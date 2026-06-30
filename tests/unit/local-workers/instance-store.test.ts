import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  bootstrapTokenPath,
  connectLocalWorker,
  deleteLocalWorkerInstance,
  instanceDir,
  instanceConfigPath,
  listLocalWorkerViews,
  reconnectLocalWorker,
  readLocalWorkerInstance,
  setLocalWorkerEnabled,
  stateDir,
} from '../../../src/local-workers/instance-store.js';

describe('local worker instance store', () => {
  let tmpDir: string;
  let dataDir: string;
  const workerUuid = '550e8400-e29b-41d4-a716-446655440000';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-worker-store-'));
    dataDir = path.join(tmpDir, 'data');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function token(workerUuidOverride = workerUuid): string {
    return Buffer.from(JSON.stringify({
      workerUuid: workerUuidOverride,
      matrixUrl: 'https://matrix.example.com',
      controllerUrl: 'https://controller.example.com',
      modelGatewayUrl: 'https://model.example.com',
    })).toString('base64');
  }

  it('stores bootstrap token outside instance.json and hides uuid from directory name', async () => {
    const instance = await connectLocalWorker({
      dataDir,
      runtime: 'claude-code',
      bootstrapToken: token(),
      workDir: path.join(tmpDir, 'project'),
    });

    expect(instance.id).toMatch(/^lw_[a-z2-7]{16}$/);
    expect(instance.id).not.toContain(workerUuid);
    expect(instance.runtimeOptions).toEqual({});

    const raw = await fs.readFile(instanceConfigPath(dataDir, instance.id), 'utf-8');
    expect(raw).not.toContain(token());
    expect(raw).not.toContain(workerUuid);
    expect(await fs.readFile(bootstrapTokenPath(dataDir, instance), 'utf-8')).toBe(token());
  });

  it('treats bootstrap token as opaque local worker data', async () => {
    const opaqueToken = 'opaque-token-owned-by-runtime-worker';

    const instance = await connectLocalWorker({
      dataDir,
      runtime: 'claude-code',
      bootstrapToken: opaqueToken,
      workDir: path.join(tmpDir, 'project'),
    });

    expect(instance.id).toMatch(/^lw_[a-z2-7]{16}$/);
    expect(await fs.readFile(bootstrapTokenPath(dataDir, instance), 'utf-8')).toBe(opaqueToken);
  });

  it('allocates a new local instance id for each new connect', async () => {
    const first = await connectLocalWorker({
      dataDir,
      runtime: 'claude-code',
      bootstrapToken: token(),
      workDir: path.join(tmpDir, 'project-a'),
    });
    const second = await connectLocalWorker({
      dataDir,
      runtime: 'claude-code',
      bootstrapToken: token(),
      workDir: path.join(tmpDir, 'project-b'),
      runtimeOptions: { 'plugin-install-scope': 'global', 'model-config-mode': 'managed-global' },
    });

    expect(second.id).not.toBe(first.id);
    expect(await readLocalWorkerInstance(dataDir, first.id)).toMatchObject({
      workDir: path.join(tmpDir, 'project-a'),
      runtimeOptions: {},
    });
    expect(await readLocalWorkerInstance(dataDir, second.id)).toMatchObject({
      workDir: path.join(tmpDir, 'project-b'),
      runtimeOptions: { 'plugin-install-scope': 'global', 'model-config-mode': 'managed-global' },
    });
  });

  it('marks an instance disabled for disconnect and lists status from local files', async () => {
    const instance = await connectLocalWorker({
      dataDir,
      runtime: 'claude-code',
      bootstrapToken: token(),
      workDir: path.join(tmpDir, 'project'),
    });

    await setLocalWorkerEnabled(dataDir, instance.id, false);
    const views = await listLocalWorkerViews(dataDir);

    expect(views).toHaveLength(1);
    expect(views[0].id).toBe(instance.id);
    expect(views[0].state).toBe('disabled');
  });

  it('reconnects a disconnected instance with the same id', async () => {
    const instance = await connectLocalWorker({
      dataDir,
      runtime: 'claude-code',
      bootstrapToken: token(),
      workDir: path.join(tmpDir, 'project-a'),
    });
    await setLocalWorkerEnabled(dataDir, instance.id, false);

    const reconnected = await reconnectLocalWorker({
      dataDir,
      instanceId: instance.id,
      workDir: path.join(tmpDir, 'project-b'),
    });

    expect(reconnected.id).toBe(instance.id);
    expect(reconnected.createdAt).toBe(instance.createdAt);
    expect(reconnected.enabled).toBe(true);
    expect(reconnected.workDir).toBe(path.join(tmpDir, 'project-b'));
  });

  it('updates the token file when reconnecting an existing instance', async () => {
    const instance = await connectLocalWorker({
      dataDir,
      runtime: 'claude-code',
      bootstrapToken: token(),
      workDir: path.join(tmpDir, 'project-a'),
    });
    const rotatedToken = token('rotated-worker-uuid');

    const reconnected = await reconnectLocalWorker({
      dataDir,
      instanceId: instance.id,
      bootstrapToken: rotatedToken,
      runtimeOptions: { 'model-config-mode': 'managed-global' },
    });

    expect(reconnected.id).toBe(instance.id);
    expect(reconnected.workDir).toBe(path.join(tmpDir, 'project-a'));
    expect(reconnected.runtimeOptions).toEqual({ 'model-config-mode': 'managed-global' });
    expect(await fs.readFile(bootstrapTokenPath(dataDir, instance), 'utf-8')).toBe(rotatedToken);
  });

  it('deletes an instance directory only after disconnect', async () => {
    const instance = await connectLocalWorker({
      dataDir,
      runtime: 'claude-code',
      bootstrapToken: token(),
      workDir: path.join(tmpDir, 'project'),
    });

    await expect(deleteLocalWorkerInstance(dataDir, instance.id)).rejects.toThrow('must be disconnected');

    await setLocalWorkerEnabled(dataDir, instance.id, false);
    await deleteLocalWorkerInstance(dataDir, instance.id);

    expect(await readLocalWorkerInstance(dataDir, instance.id)).toBeNull();
    await expect(fs.stat(instanceDir(dataDir, instance.id))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(listLocalWorkerViews(dataDir)).resolves.toEqual([]);
  });

  it('marks a running local worker degraded when heartbeat is stale', async () => {
    const instance = await connectLocalWorker({
      dataDir,
      runtime: 'claude-code',
      bootstrapToken: token(),
      workDir: path.join(tmpDir, 'project'),
    });
    const sDir = stateDir(dataDir, instance.id);
    await fs.writeFile(
      path.join(sDir, 'supervisor-status.json'),
      JSON.stringify({ state: 'running', pid: process.pid }),
      'utf-8',
    );
    await fs.writeFile(
      path.join(sDir, 'status.json'),
      JSON.stringify({
        phase: 'Running',
        updatedAt: new Date(Date.now() - 300_000).toISOString(),
      }),
      'utf-8',
    );

    const views = await listLocalWorkerViews(dataDir);

    expect(views).toHaveLength(1);
    expect(views[0].state).toBe('degraded');
  });

  it('fills list display fields from worker status and runtime snapshots', async () => {
    const instance = await connectLocalWorker({
      dataDir,
      runtime: 'claude-code',
      bootstrapToken: token(),
      workDir: path.join(tmpDir, 'project'),
    });
    const sDir = stateDir(dataDir, instance.id);
    await fs.writeFile(
      path.join(sDir, 'supervisor-status.json'),
      JSON.stringify({ state: 'running', pid: process.pid }),
      'utf-8',
    );
    await fs.writeFile(
      path.join(sDir, 'status.json'),
      JSON.stringify({
        runtime: 'claude-code',
        phase: 'Running',
        workerName: 'worker3',
        workerResourceName: 'example-worker-worker3',
        updatedAt: new Date().toISOString(),
      }),
      'utf-8',
    );
    await fs.writeFile(
      path.join(sDir, 'runtime-state.json'),
      JSON.stringify({
        member: {
          name: 'example-worker-worker3',
          runtimeName: 'worker3',
          personalRoomId: '!personal-room:example.com',
        },
        storage: {
          teamPrefix: 'teams/test-team',
        },
      }),
      'utf-8',
    );
    await fs.writeFile(
      path.join(sDir, 'matrix-state.json'),
      JSON.stringify({
        matrixSyncToken: '42',
        matrixCursors: {
          '!team-room:example.com': '$event',
        },
      }),
      'utf-8',
    );

    const views = await listLocalWorkerViews(dataDir);

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      state: 'running',
      workerName: 'worker3',
      teamName: 'test-team',
      matrix: 'connected',
      roomId: '!team-room:example.com',
    });
  });
});
