import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import type { AgentDefinition, DeployedAgentRecord } from '../../../src/types/index.js';
import {
  applyPersistedDeployTargets,
  backfillLifecycleFields,
  homeFromConfigFile,
  lifecycleFieldsForDeploy,
} from '../../../src/deployment/persisted-deploy-paths.js';

describe('persisted deploy paths', () => {
  it('treats a hooks/ parent as the Agent home', () => {
    expect(homeFromConfigFile('/workspace/.grok/hooks/loongsuite-pilot.json'))
      .toBe(path.resolve('/workspace/.grok'));
  });

  it('treats settings.json parent as the Pi Agent home', () => {
    expect(homeFromConfigFile('/tmp/pi-agent/settings.json'))
      .toBe(path.resolve('/tmp/pi-agent'));
  });

  it('records Grok and Pi absolute paths and ignores other agents', () => {
    expect(lifecycleFieldsForDeploy({
      id: 'grok-build',
      displayName: 'Grok',
      deployMode: 'hook',
      detection: { paths: ['/custom/.grok'], commands: [] },
      hook: {
        settingsPath: '/custom/.grok/hooks/loongsuite-pilot.json',
        events: ['stop'],
        hookCommand: '/pilot/hooks/grok.sh',
        format: 'nested',
      },
    })).toEqual({
      hookSettingsPath: path.resolve('/custom/.grok/hooks/loongsuite-pilot.json'),
    });

    expect(lifecycleFieldsForDeploy({
      id: 'pi-coding-agent',
      displayName: 'Pi',
      deployMode: 'plugin-inject',
      detection: { paths: ['/tmp/pi-agent'], commands: ['pi'] },
      pluginInject: {
        configPaths: ['/tmp/pi-agent/settings.json'],
        pluginSpec: '/pilot/plugins/pi-coding-agent/index.mjs',
        pluginId: 'loongsuite-pilot-pi-coding-agent',
        configKey: 'extensions',
      },
    })).toEqual({
      pluginInjectConfigPath: path.resolve('/tmp/pi-agent/settings.json'),
    });

    expect(lifecycleFieldsForDeploy({
      id: 'cursor',
      displayName: 'Cursor',
      deployMode: 'hook',
      detection: { paths: ['/home/user/.cursor'], commands: [] },
      hook: {
        settingsPath: '/home/user/.cursor/hooks.json',
        events: ['Stop'],
        hookCommand: '/pilot/hooks/cursor.sh',
        format: 'nested',
      },
    })).toEqual({});
  });

  it('overlays persisted Grok/Pi paths ahead of the current definition', () => {
    const grok: AgentDefinition = {
      id: 'grok-build',
      displayName: 'Grok',
      deployMode: 'hook',
      detection: { paths: ['/root/.grok'], commands: [] },
      hook: {
        settingsPath: '/root/.grok/hooks/loongsuite-pilot.json',
        events: ['stop'],
        hookCommand: '/pilot/hooks/grok.sh',
        format: 'nested',
      },
    };
    const overlaid = applyPersistedDeployTargets(grok, {
      deployMode: 'hook',
      deployedAt: '2026-01-01T00:00:00.000Z',
      hookSettingsPath: '/workspace/.grok/hooks/loongsuite-pilot.json',
    });
    expect(overlaid.hook?.settingsPath).toBe(path.resolve('/workspace/.grok/hooks/loongsuite-pilot.json'));
    expect(overlaid.detection.paths[0]).toBe(path.resolve('/workspace/.grok'));
  });

  it('does not replace an already persisted path during backfill', () => {
    const record: DeployedAgentRecord = {
      deployMode: 'hook',
      deployedAt: '2026-01-01T00:00:00.000Z',
      hookSettingsPath: '/workspace/.grok/hooks/loongsuite-pilot.json',
    };
    backfillLifecycleFields(record, {
      id: 'grok-build',
      displayName: 'Grok',
      deployMode: 'hook',
      detection: { paths: ['/root/.grok'], commands: [] },
      hook: {
        settingsPath: '/root/.grok/hooks/loongsuite-pilot.json',
        events: ['stop'],
        hookCommand: '/pilot/hooks/grok.sh',
        format: 'nested',
      },
    });
    expect(record.hookSettingsPath).toBe('/workspace/.grok/hooks/loongsuite-pilot.json');
  });
});
