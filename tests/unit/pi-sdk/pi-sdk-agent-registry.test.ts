import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildPiSdkAgentDefinition,
  doctorPiSdkAgent,
  ensureRegisteredPiSdkWrappers,
  listRegisteredPiSdkAgents,
  registerPiSdkAgent,
  unregisterPiSdkAgent,
} from '../../../src/pi-sdk/pi-sdk-agent-registry.js';
import { PluginInjectStrategy } from '../../../src/deployment/plugin-inject-strategy.js';

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
    expect(wrapper).toContain('"framework": "pi"');
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
