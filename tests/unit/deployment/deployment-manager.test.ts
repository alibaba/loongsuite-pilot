import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DeploymentManager } from '../../../src/deployment/deployment-manager.js';
import type { AgentDefinition } from '../../../src/types/index.js';

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

vi.mock('../../../src/deployment/deploy-notification.js', () => ({
  writeDeployNotification: vi.fn(),
}));

import { detectAgent } from '../../../src/deployment/detect-utils.js';
import { writeDeployNotification } from '../../../src/deployment/deploy-notification.js';

describe('DeploymentManager', () => {
  let tmpDir: string;
  let dataDir: string;
  let pilotDir: string;
  let builtinDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-mgr-'));
    dataDir = path.join(tmpDir, 'data');
    pilotDir = path.join(tmpDir, 'pilot');
    builtinDir = path.join(tmpDir, 'agents.d');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(pilotDir, { recursive: true });
    await fs.mkdir(builtinDir, { recursive: true });
    await fs.mkdir(path.join(dataDir, 'agents.d.local'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeManager() {
    return new DeploymentManager({
      dataDir,
      pilotDir,
      builtinAgentsDir: builtinDir,
    });
  }

  function writeAgentDef(def: AgentDefinition) {
    return fs.writeFile(path.join(builtinDir, `${def.id}.json`), JSON.stringify(def));
  }

  describe('deployAll', () => {
    it('deploys hook agents that are detected', async () => {
      const def: AgentDefinition = {
        id: 'cursor-test',
        displayName: 'Cursor Test',
        deployMode: 'hook',
        detection: { paths: ['/tmp/cursor-exists'], commands: [] },
        hook: {
          settingsPath: path.join(tmpDir, 'cursor-hooks.json'),
          events: ['Stop'],
          hookCommand: '/opt/test/hook.sh',
          format: 'flat',
        },
      };
      await writeAgentDef(def);
      vi.mocked(detectAgent).mockResolvedValue(true);

      const mgr = makeManager();
      const results = await mgr.deployAll();

      expect(results).toHaveLength(1);
      expect(results[0].agentId).toBe('cursor-test');
    });

    it('skips agents that are not detected', async () => {
      const def: AgentDefinition = {
        id: 'missing-agent',
        displayName: 'Missing',
        deployMode: 'hook',
        detection: { paths: ['/nonexistent'], commands: [] },
        hook: {
          settingsPath: path.join(tmpDir, 'missing.json'),
          events: ['Stop'],
          hookCommand: '/opt/hook.sh',
          format: 'flat',
        },
      };
      await writeAgentDef(def);
      vi.mocked(detectAgent).mockResolvedValue(false);

      const mgr = makeManager();
      const results = await mgr.deployAll();

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
    });

    it('does not detect or deploy agents disabled by the caller', async () => {
      const enabledDef: AgentDefinition = {
        id: 'enabled-agent',
        displayName: 'Enabled',
        deployMode: 'hook',
        detection: { paths: [], commands: [] },
        hook: {
          settingsPath: path.join(tmpDir, 'enabled-hooks.json'),
          events: ['Stop'],
          hookCommand: '/opt/enabled.sh',
          format: 'flat',
        },
      };
      const disabledDef: AgentDefinition = {
        id: 'disabled-agent',
        displayName: 'Disabled',
        deployMode: 'hook',
        detection: { paths: [], commands: [] },
        hook: {
          settingsPath: path.join(tmpDir, 'disabled-hooks.json'),
          events: ['Stop'],
          hookCommand: '/opt/disabled.sh',
          format: 'flat',
        },
      };
      await writeAgentDef(enabledDef);
      await writeAgentDef(disabledDef);
      vi.mocked(detectAgent).mockResolvedValue(true);

      const mgr = makeManager();
      const results = await mgr.deployAll(def => def.id === enabledDef.id);

      expect(results).toHaveLength(2);
      expect(results.find(result => result.agentId === disabledDef.id)?.skipped).toBe(true);
      expect(vi.mocked(detectAgent)).toHaveBeenCalledTimes(1);
      expect(await fs.stat(path.join(tmpDir, 'enabled-hooks.json'))).toBeDefined();
      await expect(fs.stat(path.join(tmpDir, 'disabled-hooks.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    // `skipped: true` on its own is ambiguous — "not installed here" and "already in
    // place" are opposite outcomes, and `deploy --require` (the image-build gate) has
    // to fail on the first and pass on the second. So the reason is part of the
    // contract, not diagnostic decoration.
    describe('skip reasons', () => {
      function hookDef(id: string): AgentDefinition {
        return {
          id,
          displayName: id,
          deployMode: 'hook',
          detection: { paths: [], commands: [] },
          hook: {
            settingsPath: path.join(tmpDir, `${id}.json`),
            events: ['Stop'],
            hookCommand: `/opt/${id}.sh`,
            format: 'flat',
          },
        };
      }

      it('reports not-detected when the agent is absent', async () => {
        await writeAgentDef(hookDef('absent-agent'));
        vi.mocked(detectAgent).mockResolvedValue(false);

        const [result] = await makeManager().deployAll();
        expect(result).toMatchObject({ success: true, skipped: true, reason: 'not-detected' });
      });

      it('reports up-to-date on a second deploy into the same dataDir', async () => {
        // Container mode deliberately keeps deployed-agents.json in the image, so a
        // derived image rebuilding on top of an instrumented base lands here. Reporting
        // anything but "satisfied" would make every rebuild fail.
        await writeAgentDef(hookDef('repeat-agent'));
        vi.mocked(detectAgent).mockResolvedValue(true);

        const mgr = makeManager();
        const first = (await mgr.deployAll())[0];
        expect(first.success).toBe(true);
        expect(first.skipped).toBeFalsy();
        expect((await mgr.deployAll())[0])
          .toMatchObject({ success: true, skipped: true, reason: 'up-to-date' });
      });

      it('reports disabled when the caller gates the agent off', async () => {
        await writeAgentDef(hookDef('gated-agent'));
        vi.mocked(detectAgent).mockResolvedValue(true);

        const [result] = await makeManager().deployAll(() => false);
        expect(result).toMatchObject({ success: true, skipped: true, reason: 'disabled' });
      });
    });

    it('undeploys a hook agent that was deployed then disabled', async () => {
      const settingsPath = path.join(tmpDir, 'toggle-hooks.json');
      const def: AgentDefinition = {
        id: 'toggle-agent',
        displayName: 'Toggle',
        deployMode: 'hook',
        detection: { paths: [], commands: [] },
        hook: {
          settingsPath,
          events: ['Stop'],
          hookCommand: '/opt/toggle.sh',
          format: 'flat',
        },
      };
      await writeAgentDef(def);
      vi.mocked(detectAgent).mockResolvedValue(true);

      const mgr = makeManager();

      // 1) enabled → hook is installed into the settings file
      await mgr.deployAll(() => true);
      const afterDeploy = await fs.readFile(settingsPath, 'utf-8');
      expect(afterDeploy).toContain('/opt/toggle.sh');

      // 2) disabled → the previously installed hook is removed, not merely skipped
      const results = await mgr.deployAll(() => false);
      expect(results.find(result => result.agentId === def.id)?.skipped).toBe(true);
      const afterDisable = await fs.readFile(settingsPath, 'utf-8');
      expect(afterDisable).not.toContain('/opt/toggle.sh');
    });

    it('removes the DSH YAML block and enabled marker when DSH is disabled', async () => {
      const pluginPath = path.join(dataDir, 'plugins', 'dsh', 'plugin.mjs');
      const patchPath = path.join(tmpDir, 'dsh-home', 'cordis.patch.yml');
      await fs.mkdir(path.dirname(pluginPath), { recursive: true });
      await fs.writeFile(pluginPath, 'export default function apply() {}\n');
      const def: AgentDefinition = {
        id: 'dsh',
        displayName: 'DeepSeek Harness',
        deployMode: 'dsh-yaml-patch',
        detection: { paths: [], commands: ['dsh'] },
        dshYamlPatch: {
          pluginSource: pluginPath,
          patchPath,
          entryId: 'loongsuite-pilot-observability',
          marker: 'PILOT-OBSERVABILITY-MANAGED',
        },
      };
      await writeAgentDef(def);
      vi.mocked(detectAgent).mockResolvedValue(true);

      const mgr = makeManager();
      expect((await mgr.deployAll(() => true))[0].success).toBe(true);
      expect(await fs.readFile(patchPath, 'utf-8')).toContain('PILOT-OBSERVABILITY-MANAGED');
      expect(await fs.readFile(path.join(path.dirname(pluginPath), '.collection-enabled'), 'utf-8'))
        .toBe('enabled\n');

      const [disabled] = await mgr.deployAll(() => false);
      expect(disabled).toMatchObject({ success: true, skipped: true });
      await expect(fs.stat(patchPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(path.join(path.dirname(pluginPath), '.collection-enabled')))
        .rejects.toMatchObject({ code: 'ENOENT' });
      expect(JSON.parse(await fs.readFile(path.join(dataDir, 'deployed-agents.json'), 'utf-8')).dsh)
        .toBeUndefined();
    });

    it('deploys DSH from a custom DSH_HOME when standard detection is false', async () => {
      const originalDshHome = process.env.DSH_HOME;
      const pluginPath = path.join(dataDir, 'plugins', 'dsh', 'plugin.mjs');
      const customHome = path.join(tmpDir, 'fc-runtime-home');
      const expectedPatch = path.join(customHome, 'cordis.patch.yml');
      await fs.mkdir(path.dirname(pluginPath), { recursive: true });
      await fs.writeFile(pluginPath, 'export default function apply() {}\n');
      const def: AgentDefinition = {
        id: 'dsh',
        displayName: 'DeepSeek Harness',
        deployMode: 'dsh-yaml-patch',
        detection: {
          paths: [path.join(tmpDir, 'missing-default-home')],
          commands: ['missing-dsh-command'],
        },
        dshYamlPatch: {
          pluginSource: pluginPath,
          entryId: 'loongsuite-pilot-observability',
          marker: 'PILOT-OBSERVABILITY-MANAGED',
        },
      };
      await writeAgentDef(def);
      vi.mocked(detectAgent).mockResolvedValue(false);

      try {
        process.env.DSH_HOME = customHome;
        const [result] = await makeManager().deployAll(() => true);

        expect(result).toMatchObject({ success: true });
        expect(result.skipped).toBeFalsy();
        expect(await fs.readFile(expectedPatch, 'utf-8')).toContain('PILOT-OBSERVABILITY-MANAGED');
        const deployed = JSON.parse(await fs.readFile(path.join(dataDir, 'deployed-agents.json'), 'utf-8'));
        expect(deployed.dsh.dshPatchPath).toBe(expectedPatch);
      } finally {
        if (originalDshHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = originalDshHome;
      }
    });

    it('persists the resolved DSH patch path and cleans it after DSH_HOME changes', async () => {
      const originalDshHome = process.env.DSH_HOME;
      const pluginPath = path.join(dataDir, 'plugins', 'dsh', 'plugin.mjs');
      const homeA = path.join(tmpDir, 'dsh-home-a');
      const homeB = path.join(tmpDir, 'dsh-home-b');
      const patchA = path.join(homeA, 'cordis.patch.yml');
      const patchB = path.join(homeB, 'cordis.patch.yml');
      await fs.mkdir(path.dirname(pluginPath), { recursive: true });
      await fs.writeFile(pluginPath, 'export default function apply() {}\n');
      const def: AgentDefinition = {
        id: 'dsh',
        displayName: 'DeepSeek Harness',
        deployMode: 'dsh-yaml-patch',
        detection: { paths: [], commands: ['dsh'] },
        dshYamlPatch: {
          pluginSource: pluginPath,
          entryId: 'loongsuite-pilot-observability',
          marker: 'PILOT-OBSERVABILITY-MANAGED',
        },
      };
      await writeAgentDef(def);
      vi.mocked(detectAgent).mockResolvedValue(true);

      try {
        process.env.DSH_HOME = homeA;
        const mgr = makeManager();
        expect((await mgr.deployAll(() => true))[0].success).toBe(true);
        const deployed = JSON.parse(
          await fs.readFile(path.join(dataDir, 'deployed-agents.json'), 'utf-8'),
        );
        expect(deployed.dsh.dshPatchPath).toBe(patchA);

        process.env.DSH_HOME = homeB;
        expect((await mgr.deployAll(() => false))[0]).toMatchObject({ success: true, skipped: true });
        await expect(fs.stat(patchA)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.stat(patchB)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        if (originalDshHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = originalDshHome;
      }
    });

    it('does not touch settings for an agent disabled without a prior deployment', async () => {
      const settingsPath = path.join(tmpDir, 'never-deployed-hooks.json');
      const def: AgentDefinition = {
        id: 'never-deployed-agent',
        displayName: 'Never Deployed',
        deployMode: 'hook',
        detection: { paths: [], commands: [] },
        hook: {
          settingsPath,
          events: ['Stop'],
          hookCommand: '/opt/never.sh',
          format: 'flat',
        },
      };
      await writeAgentDef(def);
      vi.mocked(detectAgent).mockResolvedValue(true);

      const mgr = makeManager();
      const results = await mgr.deployAll(() => false);

      expect(results.find(result => result.agentId === def.id)?.skipped).toBe(true);
      // No state record → cleanup must not create/rewrite the settings file.
      await expect(fs.stat(settingsPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('keeps the deploy record when undeploy fails so cleanup is retried', async () => {
      const def: AgentDefinition = {
        id: 'retry-agent',
        displayName: 'Retry',
        deployMode: 'hook',
        detection: { paths: [], commands: [] },
        hook: {
          settingsPath: path.join(tmpDir, 'retry-hooks.json'),
          events: ['Stop'],
          hookCommand: '/opt/retry.sh',
          format: 'flat',
        },
      };
      await writeAgentDef(def);
      vi.mocked(detectAgent).mockResolvedValue(true);

      const mgr = makeManager();
      await mgr.deployAll(() => true); // record created

      const undeploySpy = vi
        .spyOn((mgr as unknown as { hookStrategy: { undeploy: (d: AgentDefinition) => Promise<boolean> } }).hookStrategy, 'undeploy')
        .mockResolvedValue(false);

      // 1st disable: undeploy fails → record kept, result surfaced as failed.
      const first = await mgr.deployAll(() => false);
      expect(first.find(result => result.agentId === def.id)?.success).toBe(false);
      expect(undeploySpy).toHaveBeenCalledTimes(1);

      // 2nd disable: record still present → cleanup retried (not early-returned).
      await mgr.deployAll(() => false);
      expect(undeploySpy).toHaveBeenCalledTimes(2);

      // Once cleanup finally succeeds the record is dropped and retries stop.
      undeploySpy.mockResolvedValue(true);
      await mgr.deployAll(() => false);
      expect(undeploySpy).toHaveBeenCalledTimes(3);
      await mgr.deployAll(() => false);
      expect(undeploySpy).toHaveBeenCalledTimes(3);
    });

    it('removes retired hook events on disable, not just current events', async () => {
      const settingsPath = path.join(tmpDir, 'retired-hooks.json');
      const withBoth: AgentDefinition = {
        id: 'retired-agent',
        displayName: 'Retired',
        deployMode: 'hook',
        detection: { paths: [], commands: [] },
        hook: {
          settingsPath,
          events: ['Stop', 'PreToolUse'],
          hookCommand: '/opt/retired.sh',
          format: 'flat',
        },
      };
      await writeAgentDef(withBoth);
      vi.mocked(detectAgent).mockResolvedValue(true);

      const mgr = makeManager();
      await mgr.deployAll(() => true); // installs Stop + PreToolUse
      const afterDeploy = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
      expect(afterDeploy.hooks.Stop).toBeDefined();
      expect(afterDeploy.hooks.PreToolUse).toBeDefined();

      // New version retires PreToolUse (current events drop it).
      await writeAgentDef({
        ...withBoth,
        hook: {
          settingsPath,
          events: ['Stop'],
          retiredEvents: ['PreToolUse'],
          hookCommand: '/opt/retired.sh',
          format: 'flat',
        },
      });

      // Disable → must remove BOTH the current Stop hook and the retired one.
      await mgr.deployAll(() => false);
      const afterDisable = await fs.readFile(settingsPath, 'utf-8');
      expect(afterDisable).not.toContain('/opt/retired.sh');
    });

    it('continues when one agent fails', async () => {
      const def1: AgentDefinition = {
        id: 'agent-ok',
        displayName: 'OK',
        deployMode: 'hook',
        detection: { paths: [], commands: [] },
        hook: {
          settingsPath: path.join(tmpDir, 'ok-hooks.json'),
          events: ['Stop'],
          hookCommand: '/opt/ok.sh',
          format: 'flat',
        },
      };
      const def2: AgentDefinition = {
        id: 'agent-bad',
        displayName: 'Bad',
        deployMode: 'hook' as any,
        detection: { paths: [], commands: [] },
        hook: undefined,
      };
      await writeAgentDef(def1);
      await writeAgentDef(def2);
      vi.mocked(detectAgent).mockResolvedValue(true);

      const mgr = makeManager();
      const results = await mgr.deployAll();

      expect(results).toHaveLength(2);
      const okResult = results.find(r => r.agentId === 'agent-ok');
      expect(okResult).toBeDefined();
    });

    it('persists state to deployed-agents.json', async () => {
      const def: AgentDefinition = {
        id: 'persist-test',
        displayName: 'Persist',
        deployMode: 'hook',
        detection: { paths: [], commands: [] },
        hook: {
          settingsPath: path.join(tmpDir, 'persist-hooks.json'),
          events: ['Stop'],
          hookCommand: '/opt/persist.sh',
          format: 'flat',
        },
      };
      await writeAgentDef(def);
      vi.mocked(detectAgent).mockResolvedValue(true);

      const mgr = makeManager();
      await mgr.deployAll();

      const stateFile = path.join(dataDir, 'deployed-agents.json');
      const state = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      expect(state).toBeDefined();
    });

    it('handles empty agents directory', async () => {
      const mgr = makeManager();
      const results = await mgr.deployAll();
      expect(results).toHaveLength(0);
    });

    it('routes directory-plugin definitions to the managed directory strategy', async () => {
      const sourceDir = path.join(dataDir, 'plugins', 'hermes-agent', 'loongsuite-pilot');
      const targetDir = path.join(tmpDir, 'hermes-home', 'plugins', 'loongsuite-pilot');
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, 'plugin.yaml'), 'name: loongsuite-pilot\n');
      const def: AgentDefinition = {
        id: 'hermes-agent',
        displayName: 'Hermes Agent',
        deployMode: 'directory-plugin',
        detection: { paths: [path.dirname(targetDir)], commands: ['hermes'] },
        directoryPlugin: { sourceDir, targetDir },
      };
      await writeAgentDef(def);
      vi.mocked(detectAgent).mockResolvedValue(true);

      const [result] = await makeManager().deployAll();

      expect(result).toMatchObject({
        success: true,
        agentId: 'hermes-agent',
        deployMode: 'directory-plugin',
      });
      expect(JSON.parse(await fs.readFile(
        path.join(targetDir, '.loongsuite-pilot-managed.json'),
        'utf8',
      ))).toMatchObject({ owner: 'loongsuite-pilot', agentId: 'hermes-agent' });
      expect(JSON.parse(await fs.readFile(
        path.join(dataDir, 'deployed-agents.json'),
        'utf8',
      ))['hermes-agent']).toMatchObject({
        deployMode: 'directory-plugin',
        targetDir: path.resolve(targetDir),
      });
    });
  });

  describe('deploySingle', () => {
    it('deploys a single agent definition', async () => {
      const def: AgentDefinition = {
        id: 'single-test',
        displayName: 'Single',
        deployMode: 'hook',
        detection: { paths: [], commands: [] },
        hook: {
          settingsPath: path.join(tmpDir, 'single-hooks.json'),
          events: ['Stop'],
          hookCommand: '/opt/single.sh',
          format: 'flat',
        },
      };
      vi.mocked(detectAgent).mockResolvedValue(true);

      const mgr = makeManager();
      const result = await mgr.deploySingle(def);

      expect(result.agentId).toBe('single-test');
    });

    it('serializes duplicate directory plugin deployments', async () => {
      const sourceDir = path.join(dataDir, 'plugins', 'hermes-agent', 'loongsuite-pilot');
      const targetDir = path.join(tmpDir, 'hermes-home', 'plugins', 'loongsuite-pilot');
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, 'plugin.yaml'), 'name: loongsuite-pilot\n');
      const def: AgentDefinition = {
        id: 'hermes-agent',
        displayName: 'Hermes Agent',
        deployMode: 'directory-plugin',
        detection: { paths: [path.dirname(targetDir)], commands: ['hermes'] },
        directoryPlugin: { sourceDir, targetDir },
      };
      vi.mocked(detectAgent).mockResolvedValue(true);

      const mgr = makeManager();
      const strategy = (mgr as any).directoryPluginStrategy;
      const originalDeploy = strategy.deploy.bind(strategy);
      const deploySpy = vi.spyOn(strategy, 'deploy').mockImplementation(async (agentDef: AgentDefinition) => {
        await new Promise(resolve => setTimeout(resolve, 30));
        return originalDeploy(agentDef);
      });

      const results = await Promise.all([
        mgr.deploySingle(def),
        mgr.deploySingle(def),
      ]);

      expect(deploySpy).toHaveBeenCalledTimes(1);
      expect(results.filter(result => result.skipped)).toHaveLength(1);
      expect(JSON.parse(await fs.readFile(
        path.join(targetDir, '.loongsuite-pilot-managed.json'),
        'utf8',
      ))).toMatchObject({ owner: 'loongsuite-pilot', agentId: 'hermes-agent' });
    });

    it('preserves state updates from concurrent agent deployments', async () => {
      const mgr = makeManager();
      const defs = ['agent-a', 'agent-b'].map((id): AgentDefinition => ({
        id,
        displayName: id,
        deployMode: 'detection-only',
        detection: { paths: [], commands: [] },
      }));
      let active = 0;
      let maxActive = 0;
      vi.spyOn(mgr as any, 'deployAgent').mockImplementation(async (def: AgentDefinition) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 20));
        (mgr as any).state[def.id] = {
          deployMode: def.deployMode,
          deployedAt: new Date().toISOString(),
        };
        active -= 1;
        return { success: true, agentId: def.id, deployMode: def.deployMode };
      });

      await Promise.all(defs.map(def => mgr.deploySingle(def)));

      expect(maxActive).toBe(1);
      expect(JSON.parse(await fs.readFile(
        path.join(dataDir, 'deployed-agents.json'),
        'utf8',
      ))).toMatchObject({
        'agent-a': { deployMode: 'detection-only' },
        'agent-b': { deployMode: 'detection-only' },
      });
    });
  });

  describe('needsRedeploy (plugin-inject self-heal check)', () => {
    function makePluginInjectDef(configPath: string): AgentDefinition {
      return {
        id: 'opencode-test',
        displayName: 'OpenCode Test',
        deployMode: 'plugin-inject',
        detection: { paths: [], commands: [] },
        pluginInject: {
          configPaths: [configPath],
          pluginSpec: 'file://$PILOT_DATA/plugins/opencode/plugin.mjs',
          pluginId: 'loongsuite-pilot-opencode',
        },
      };
    }

    it('returns false when the plugin spec is present in the config', async () => {
      const configPath = path.join(tmpDir, 'opencode.json');
      const resolvedSpec = `file://${path.join(dataDir, 'plugins', 'opencode', 'plugin.mjs')}`;
      await fs.writeFile(configPath, JSON.stringify({ plugin: [resolvedSpec] }));

      const mgr = makeManager();
      const def = makePluginInjectDef(configPath);

      expect(await mgr.needsRedeploy(def)).toBe(false);
    });

    it('returns true when the plugin spec was removed from the config', async () => {
      const configPath = path.join(tmpDir, 'opencode.json');
      await fs.writeFile(configPath, JSON.stringify({ plugin: ['some-other-plugin'] }));

      const mgr = makeManager();
      const def = makePluginInjectDef(configPath);

      expect(await mgr.needsRedeploy(def)).toBe(true);
    });

    it('returns true when no config file exists', async () => {
      const mgr = makeManager();
      const def = makePluginInjectDef(path.join(tmpDir, 'does-not-exist.json'));

      expect(await mgr.needsRedeploy(def)).toBe(true);
    });

    it('matches by pluginId even when the exact spec string differs', async () => {
      const configPath = path.join(tmpDir, 'opencode.json');
      // Entry contains the pluginId but not the exact resolved file path.
      await fs.writeFile(configPath, JSON.stringify({ plugin: ['loongsuite-pilot-opencode@1.2.3'] }));

      const mgr = makeManager();
      const def = makePluginInjectDef(configPath);

      expect(await mgr.needsRedeploy(def)).toBe(false);
    });
  });

  describe('getDefinitions', () => {
    it('returns loaded definitions after deployAll', async () => {
      const def: AgentDefinition = {
        id: 'def-test',
        displayName: 'Def Test',
        deployMode: 'hook',
        detection: { paths: [], commands: [] },
      };
      await writeAgentDef(def);

      const mgr = makeManager();
      await mgr.deployAll();

      const defs = mgr.getDefinitions();
      expect(defs).toHaveLength(1);
      expect(defs[0].id).toBe('def-test');
    });

    it('returns empty array before deployAll', () => {
      const mgr = makeManager();
      expect(mgr.getDefinitions()).toHaveLength(0);
    });
  });
});
