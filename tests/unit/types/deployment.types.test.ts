import { describe, expect, it } from 'vitest';
import type {
  AgentDefinition,
  DeployMode,
  DshYamlPatchConfig,
} from '../../../src/types/index.js';

describe('deployment types — dsh-yaml-patch', () => {
  it('DeployMode union includes dsh-yaml-patch', () => {
    const modes: DeployMode[] = [
      'hook',
      'plugin-probe',
      'plugin-inject',
      'directory-plugin',
      'detection-only',
      'dsh-yaml-patch',
    ];
    expect(modes).toContain('dsh-yaml-patch');
  });

  it('DshYamlPatchConfig accepts all required fields', () => {
    const cfg: DshYamlPatchConfig = {
      pluginSource: 'file:///x/plugin.mjs',
      entryId: 'loongsuite-pilot-observability',
      marker: 'PILOT-OBSERVABILITY-MANAGED',
    };
    expect(cfg.entryId).toBe('loongsuite-pilot-observability');
    expect(cfg.marker).toBe('PILOT-OBSERVABILITY-MANAGED');
  });

  it('DshYamlPatchConfig patchPath is optional', () => {
    const cfg: DshYamlPatchConfig = {
      pluginSource: 'file:///x/plugin.mjs',
      entryId: 'loongsuite-pilot-observability',
      marker: 'PILOT-OBSERVABILITY-MANAGED',
      patchPath: '/tmp/cordis.patch.yml',
    };
    expect(cfg.patchPath).toBe('/tmp/cordis.patch.yml');
  });

  it('AgentDefinition allows dshYamlPatch field for dsh-yaml-patch mode', () => {
    const def: AgentDefinition = {
      id: 'dsh',
      displayName: 'DeepSeek Harness',
      deployMode: 'dsh-yaml-patch',
      detection: { paths: ['~/.dsh'], commands: ['dsh'] },
      dshYamlPatch: {
        pluginSource: 'file:///x/plugin.mjs',
        entryId: 'loongsuite-pilot-observability',
        marker: 'PILOT-OBSERVABILITY-MANAGED',
      },
    };
    expect(def.deployMode).toBe('dsh-yaml-patch');
    expect(def.dshYamlPatch?.entryId).toBe('loongsuite-pilot-observability');
  });

  it('AgentDefinition.dshYamlPatch is optional for non-dsh modes', () => {
    const def: AgentDefinition = {
      id: 'other',
      displayName: 'Other',
      deployMode: 'hook',
      detection: { paths: [], commands: [] },
    };
    expect(def.dshYamlPatch).toBeUndefined();
  });
});
