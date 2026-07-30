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

  describe('required hook asset repair', () => {
    function makeGrokDef(): AgentDefinition {
      return {
        id: 'grok-build',
        displayName: 'Grok Build',
        deployMode: 'hook',
        detection: { paths: [path.join(tmpDir, '.grok')], commands: [] },
        hook: {
          settingsPath: path.join(tmpDir, '.grok', 'hooks', 'loongsuite-pilot.json'),
          events: ['Stop'],
          retiredEvents: ['SubagentStart'],
          hookCommand: path.join(dataDir, 'hooks', 'grok-build-loongsuite-pilot-hook.sh'),
          requiredAssets: [
            'grok-build-loongsuite-pilot-hook.sh',
            'grok-build',
          ],
          format: 'nested',
          matcher: '',
          eventSubcommand: 'kebab-case',
          eventKeyCase: 'snake',
        },
      };
    }

    async function writePackagedAssets(): Promise<void> {
      const sourceRoot = path.join(pilotDir, 'assets', 'hooks');
      await fs.mkdir(path.join(sourceRoot, 'grok-build'), { recursive: true });
      await fs.writeFile(
        path.join(sourceRoot, 'grok-build-loongsuite-pilot-hook.sh'),
        '#!/usr/bin/env bash\n',
        { mode: 0o755 },
      );
      await fs.writeFile(
        path.join(sourceRoot, 'grok-build', 'processor.mjs'),
        'export const version = 1;\n',
      );
    }

    async function writeHealthySettings(def: AgentDefinition): Promise<void> {
      await fs.mkdir(path.dirname(def.hook!.settingsPath), { recursive: true });
      await fs.writeFile(def.hook!.settingsPath, JSON.stringify({
        hooks: {
          stop: [{
            matcher: '',
            hooks: [{
              command: `${def.hook!.hookCommand} stop`,
              type: 'command',
            }],
          }],
        },
      }));
    }

    it('detects modified required assets even when hook registration is healthy', async () => {
      const def = makeGrokDef();
      await writePackagedAssets();
      await writeHealthySettings(def);
      await fs.mkdir(path.join(dataDir, 'hooks', 'grok-build'), { recursive: true });
      await fs.copyFile(
        path.join(pilotDir, 'assets', 'hooks', 'grok-build-loongsuite-pilot-hook.sh'),
        path.join(dataDir, 'hooks', 'grok-build-loongsuite-pilot-hook.sh'),
      );
      await fs.copyFile(
        path.join(pilotDir, 'assets', 'hooks', 'grok-build', 'processor.mjs'),
        path.join(dataDir, 'hooks', 'grok-build', 'processor.mjs'),
      );
      const mgr = makeManager();

      expect(await mgr.needsRedeploy(def)).toBe(false);
      await fs.writeFile(
        path.join(dataDir, 'hooks', 'grok-build', 'processor.mjs'),
        'tampered\n',
      );
      expect(await mgr.needsRedeploy(def)).toBe(true);
    });

    it('restores assets and missing settings through repairSingle', async () => {
      const def = makeGrokDef();
      await writePackagedAssets();
      await fs.mkdir(path.join(tmpDir, '.grok'), { recursive: true });
      vi.mocked(detectAgent).mockResolvedValue(true);
      const mgr = makeManager();

      const result = await mgr.repairSingle(def);

      expect(result.success).toBe(true);
      expect(await fs.readFile(
        path.join(dataDir, 'hooks', 'grok-build', 'processor.mjs'),
        'utf-8',
      )).toBe('export const version = 1;\n');
      expect((await fs.stat(
        path.join(dataDir, 'hooks', 'grok-build-loongsuite-pilot-hook.sh'),
      )).mode & 0o111).not.toBe(0);
      expect(JSON.parse(await fs.readFile(def.hook!.settingsPath, 'utf-8')))
        .toMatchObject({
          hooks: {
            stop: [{
              hooks: [{
                command: `${def.hook!.hookCommand} stop`,
              }],
            }],
          },
        });
      expect(await mgr.needsRedeploy(def)).toBe(false);
    });

    it('fails repair when a declared packaged asset is missing', async () => {
      const def = makeGrokDef();
      await fs.mkdir(path.join(tmpDir, '.grok'), { recursive: true });
      vi.mocked(detectAgent).mockResolvedValue(true);

      const result = await makeManager().repairSingle(def);

      expect(result.success).toBe(false);
      expect(result.error).toBe('failed to restore required hook assets');
    });

    it('exposes the deployment strategy detection result to watchdog targets', async () => {
      const def = makeGrokDef();
      vi.mocked(detectAgent).mockResolvedValue(true);

      expect(await makeManager().isDetected(def)).toBe(true);
      expect(detectAgent).toHaveBeenCalledWith(def.detection);
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
