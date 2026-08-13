import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildPiSdkAgentDefinition,
  doctorPiSdkAgent,
  ensureRegisteredPiSdkWrappers,
  PI_SDK_REGISTRY_PROCESS_PATTERNS,
  PiSdkRegistryBusyError,
  listRegisteredPiSdkAgents,
  registerPiSdkAgent,
  unregisterPiSdkAgent,
} from '../../../src/pi-sdk/pi-sdk-agent-registry.js';
import { PluginInjectStrategy } from '../../../src/deployment/plugin-inject-strategy.js';
import { acquireSingleInstanceLock } from '../../../src/utils/single-instance-lock.js';
import { isCommandMatch } from '../../../src/utils/pid-utils.js';

describe('PI SDK Agent registry', () => {
  let tmpDir: string;
  let dataDir: string;
  let agentDir: string;
  let detectionPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sdk-agent-registry-'));
    dataDir = path.join(tmpDir, 'pilot-data');
    agentDir = path.join(tmpDir, 'acme-agent');
    detectionPath = path.join(tmpDir, 'acme-installed');
    await fs.mkdir(detectionPath, { recursive: true });
    await installPiRuntimeFixture(dataDir);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('materializes a managed plugin-inject definition and injects its wrapper', async () => {
    const result = await registerPiSdkAgent({
      dataDir,
      id: 'acme-code',
      name: 'Acme Code Agent',
      agentDir,
      detectionPaths: [detectionPath],
      detectionCommands: ['acme-code'],
    });

    const settings = JSON.parse(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8'));
    const definition = JSON.parse(await fs.readFile(result.definitionPath, 'utf8'));
    const wrapper = await fs.readFile(result.wrapperPath, 'utf8');

    expect(settings.extensions).toEqual([result.wrapperPath]);
    expect(definition).toMatchObject({
      id: 'acme-code',
      deployMode: 'plugin-inject',
      piSdk: { schemaVersion: 1, agentDir },
      pluginInject: {
        configKey: 'extensions',
        pluginId: 'loongsuite-pilot-pi-sdk-acme-code',
      },
    });
    expect(definition.detection.paths).toEqual([detectionPath]);
    expect(wrapper).toContain("createPiTelemetryExtension");
    expect(wrapper).toContain('"agentType": "acme-code"');
    expect(wrapper).toContain('"framework": "pi-coding-agent"');
    if (process.platform !== 'win32') {
      expect((await fs.stat(result.wrapperPath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(result.definitionPath)).mode & 0o777).toBe(0o600);
    }
  });

  it('is idempotent and supports doctor, list, and unregister', async () => {
    const request = {
      dataDir,
      id: 'acme-code',
      name: 'Acme Code Agent',
      agentDir,
      detectionPaths: [detectionPath],
    };
    const first = await registerPiSdkAgent(request);
    await registerPiSdkAgent(request);

    const settings = JSON.parse(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8'));
    expect(settings.extensions).toEqual([first.wrapperPath]);
    expect((await listRegisteredPiSdkAgents(dataDir)).map(def => def.id)).toEqual(['acme-code']);
    await expect(doctorPiSdkAgent(dataDir, 'acme-code')).resolves.toMatchObject({
      detected: true,
      runtimePresent: true,
      wrapperPresent: true,
      injectionPresent: true,
      healthy: true,
    });
    await fs.rm(detectionPath, { recursive: true });
    await expect(doctorPiSdkAgent(dataDir, 'acme-code')).resolves.toMatchObject({
      detected: false,
      healthy: false,
    });

    await expect(unregisterPiSdkAgent(dataDir, 'acme-code')).resolves.toMatchObject({
      injectionRemoved: true,
      definitionRemoved: true,
    });
    const cleanedSettings = JSON.parse(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8'));
    expect(cleanedSettings.extensions).toEqual([]);
    await expect(fs.access(first.wrapperPath)).rejects.toThrow();
    await expect(fs.access(first.definitionPath)).rejects.toThrow();
  });

  it('removes the old settings entry when a registration moves to another agentDir', async () => {
    const request = {
      dataDir,
      id: 'acme-code',
      name: 'Acme Code Agent',
      agentDir,
      detectionPaths: [detectionPath],
    };
    await registerPiSdkAgent(request);
    const nextAgentDir = path.join(tmpDir, 'acme-agent-v2');
    await registerPiSdkAgent({ ...request, agentDir: nextAgentDir });

    const oldSettings = JSON.parse(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8'));
    const nextSettings = JSON.parse(await fs.readFile(path.join(nextAgentDir, 'settings.json'), 'utf8'));
    expect(oldSettings.extensions).toEqual([]);
    expect(nextSettings.extensions).toHaveLength(1);
  });

  it('preserves the registration and wrapper when settings cleanup fails', async () => {
    const result = await registerPiSdkAgent({
      dataDir,
      id: 'acme-code',
      name: 'Acme Code Agent',
      agentDir,
      detectionPaths: [detectionPath],
    });
    vi.spyOn(PluginInjectStrategy.prototype, 'undeploy').mockResolvedValueOnce(false);

    await expect(unregisterPiSdkAgent(dataDir, 'acme-code')).rejects.toThrow(
      'registration preserved for retry',
    );

    const settings = JSON.parse(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8'));
    expect(settings.extensions).toEqual([result.wrapperPath]);
    await expect(fs.access(result.definitionPath)).resolves.toBeUndefined();
    await expect(fs.access(result.wrapperPath)).resolves.toBeUndefined();
    await expect(doctorPiSdkAgent(dataDir, 'acme-code')).resolves.toMatchObject({
      injectionPresent: true,
      wrapperPresent: true,
      healthy: true,
    });
  });

  it('restores a missing generated wrapper from the durable registration', async () => {
    const result = await registerPiSdkAgent({
      dataDir,
      id: 'acme-code',
      name: 'Acme Code Agent',
      agentDir,
      detectionPaths: [detectionPath],
    });
    const original = await fs.readFile(result.wrapperPath, 'utf8');
    await fs.unlink(result.wrapperPath);

    await expect(ensureRegisteredPiSdkWrappers(dataDir)).resolves.toBe(1);
    await expect(fs.readFile(result.wrapperPath, 'utf8')).resolves.toBe(original);
    await expect(ensureRegisteredPiSdkWrappers(dataDir)).resolves.toBe(0);
  });

  it('retries transient registry contention before restoring a wrapper', async () => {
    const result = await registerPiSdkAgent({
      dataDir,
      id: 'acme-code',
      name: 'Acme Code Agent',
      agentDir,
      detectionPaths: [detectionPath],
    });
    await fs.unlink(result.wrapperPath);
    const blocker = acquireSingleInstanceLock(path.join(dataDir, 'pi-sdk-registry.lock'));
    expect(blocker.lock).not.toBeNull();

    const restore = ensureRegisteredPiSdkWrappers(dataDir);
    setTimeout(() => blocker.lock!.release(), 20);

    await expect(restore).resolves.toBe(1);
    await expect(fs.readFile(result.wrapperPath, 'utf8')).resolves.toContain('createPiTelemetryExtension');
  });

  it('bounds wrapper restore retries and preserves a typed busy error', async () => {
    vi.useFakeTimers();
    const blocker = acquireSingleInstanceLock(path.join(dataDir, 'pi-sdk-registry.lock'));
    expect(blocker.lock).not.toBeNull();

    const restore = ensureRegisteredPiSdkWrappers(dataDir);
    const assertion = expect(restore).rejects.toBeInstanceOf(PiSdkRegistryBusyError);
    await vi.advanceTimersByTimeAsync(400);
    await assertion;
    blocker.lock!.release();
  });

  it('recognizes collector and Agent CLI processes as valid registry lock owners', () => {
    expect(isCommandMatch(
      '/usr/bin/node /opt/loongsuite-pilot/bin/collector-daemon.js',
      PI_SDK_REGISTRY_PROCESS_PATTERNS,
    )).toBe(true);
    expect(isCommandMatch(
      '/usr/bin/node /opt/loongsuite-pilot/versions/v1/dist/index.js agent register pi-sdk --id acme',
      PI_SDK_REGISTRY_PROCESS_PATTERNS,
    )).toBe(true);
    expect(isCommandMatch(
      'powershell.exe loongsuite-pilot.ps1 agent unregister acme-code',
      PI_SDK_REGISTRY_PROCESS_PATTERNS,
    )).toBe(true);
    expect(isCommandMatch('/Applications/Example IDE.app/Contents/MacOS/Example IDE', PI_SDK_REGISTRY_PROCESS_PATTERNS)).toBe(false);
  });

  it('scopes exit and signal cleanup listeners to the registry critical section', async () => {
    const baselineExitListeners = process.listeners('exit');
    const baselineSigintListeners = process.listeners('SIGINT');
    const baselineSigtermListeners = process.listeners('SIGTERM');
    let finishDeploy!: (value: unknown) => void;
    vi.spyOn(PluginInjectStrategy.prototype, 'deploy').mockImplementationOnce(() => new Promise(resolve => {
      finishDeploy = resolve;
    }) as never);

    const registration = registerPiSdkAgent({
      dataDir,
      id: 'acme-code',
      name: 'Acme Code Agent',
      agentDir,
      detectionPaths: [detectionPath],
    });
    await vi.waitFor(() => expect(finishDeploy).toBeTypeOf('function'));
    expect(process.listenerCount('exit')).toBe(baselineExitListeners.length + 1);
    expect(process.listenerCount('SIGINT')).toBe(baselineSigintListeners.length + 1);
    expect(process.listenerCount('SIGTERM')).toBe(baselineSigtermListeners.length + 1);

    const sigintCleanup = process.listeners('SIGINT')
      .find(listener => !baselineSigintListeners.includes(listener));
    expect(sigintCleanup).toBeTypeOf('function');
    sigintCleanup!();
    const reacquired = acquireSingleInstanceLock(path.join(dataDir, 'pi-sdk-registry.lock'));
    expect(reacquired.lock).not.toBeNull();
    reacquired.lock!.release();

    finishDeploy({ success: true, agentId: 'acme-code', deployMode: 'plugin-inject' });
    await expect(registration).resolves.toMatchObject({ definition: { id: 'acme-code' } });
    expect(process.listeners('exit')).toEqual(baselineExitListeners);
    expect(process.listeners('SIGINT')).toEqual(baselineSigintListeners);
    expect(process.listeners('SIGTERM')).toEqual(baselineSigtermListeners);
  });

  it('rejects unsafe, reserved, and under-specified registrations', () => {
    expect(() => buildPiSdkAgentDefinition({
      id: 'pi-coding-agent',
      name: 'Reserved',
      agentDir,
      detectionPaths: [detectionPath],
    })).toThrow('reserved');
    expect(() => buildPiSdkAgentDefinition({
      id: '../escape',
      name: 'Unsafe',
      agentDir,
      detectionPaths: [detectionPath],
    })).toThrow('agent id');
    expect(() => buildPiSdkAgentDefinition({
      id: 'acme-code',
      name: 'Acme',
      agentDir,
    })).toThrow('at least one');
  });

  it('does not overwrite an unrelated local Agent definition', async () => {
    const definitionDir = path.join(dataDir, 'agents.d.local');
    await fs.mkdir(definitionDir, { recursive: true });
    await fs.writeFile(path.join(definitionDir, 'acme-code.json'), JSON.stringify({
      id: 'acme-code',
      displayName: 'Unrelated',
      deployMode: 'detection-only',
      detection: { paths: [detectionPath], commands: [] },
    }));

    await expect(registerPiSdkAgent({
      dataDir,
      id: 'acme-code',
      name: 'Acme',
      agentDir,
      detectionPaths: [detectionPath],
    })).rejects.toThrow('not managed as PI SDK');
  });

  it('refuses to inject a wrapper that cannot load the Pilot PI runtime', async () => {
    await fs.rm(path.join(dataDir, 'plugins', 'pi-coding-agent', 'index.mjs'));

    await expect(registerPiSdkAgent({
      dataDir,
      id: 'acme-code',
      name: 'Acme',
      agentDir,
      detectionPaths: [detectionPath],
    })).rejects.toThrow('runtime is missing');
    await expect(fs.access(path.join(agentDir, 'settings.json'))).rejects.toThrow();
  });

  it('requires a dedicated agentDir to prevent duplicate telemetry identities', async () => {
    await registerPiSdkAgent({
      dataDir,
      id: 'acme-code',
      name: 'Acme',
      agentDir,
      detectionPaths: [detectionPath],
    });

    await expect(registerPiSdkAgent({
      dataDir,
      id: 'other-code',
      name: 'Other',
      agentDir,
      detectionPaths: [detectionPath],
    })).rejects.toThrow('already registered to PI SDK Agent acme-code');

    await expect(registerPiSdkAgent({
      dataDir,
      id: 'default-dir-code',
      name: 'Default Dir',
      agentDir: path.join(os.homedir(), '.pi', 'agent'),
      detectionPaths: [detectionPath],
    })).rejects.toThrow('must be dedicated');
  });

  it('serializes concurrent registrations before checking the dedicated agentDir', async () => {
    const requests = ['first-code', 'second-code'].map(id => registerPiSdkAgent({
      dataDir,
      id,
      name: id,
      agentDir,
      detectionPaths: [detectionPath],
    }));

    const results = await Promise.allSettled(requests);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected' });
    expect(rejected.status === 'rejected' ? String(rejected.reason) : '').toContain('registry is busy');

    const definitions = await listRegisteredPiSdkAgents(dataDir);
    expect(definitions).toHaveLength(1);
    const settings = JSON.parse(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8'));
    expect(settings.extensions).toHaveLength(1);
    await expect(fs.access(path.join(dataDir, 'pi-sdk-registry.lock'))).rejects.toThrow();
  });
});

async function installPiRuntimeFixture(dataDir: string): Promise<void> {
  const piTarget = path.join(dataDir, 'plugins', 'pi-coding-agent');
  const sharedTarget = path.join(dataDir, 'plugins', 'shared');
  await fs.mkdir(piTarget, { recursive: true });
  await fs.mkdir(sharedTarget, { recursive: true });
  await fs.copyFile(
    path.join(process.cwd(), 'assets', 'plugins', 'pi-coding-agent', 'index.mjs'),
    path.join(piTarget, 'index.mjs'),
  );
  await fs.copyFile(
    path.join(process.cwd(), 'assets', 'plugins', 'shared', 'resource-context.mjs'),
    path.join(sharedTarget, 'resource-context.mjs'),
  );
}
