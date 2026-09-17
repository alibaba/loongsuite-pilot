import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const installerSh = readFileSync(resolve('deploy', 'installer-opensource.sh'), 'utf8');
const installerPs1 = readFileSync(resolve('deploy', 'installer-opensource.ps1'), 'utf8');

describe('public installer multimodal mode flag', () => {
  it('shell installer accepts --multimodal-mode and writes uploadMode', () => {
    expect(installerSh).toContain('MULTIMODAL_MODE=""');
    expect(installerSh).toContain('--multimodal-mode)');
    expect(installerSh).toContain('--multimodal-mode=*)');
    expect(installerSh).toContain('LP_MULTIMODAL_MODE="$MULTIMODAL_MODE"');
    expect(installerSh).toContain('LP_MULTIMODAL_AGENTS="$MULTIMODAL_AGENTS"');
    expect(installerSh).toContain('--multimodal-mode is only supported with install');
    expect(installerSh).toContain("none|input|output|tool|both)");
    expect(installerSh).toContain('if [ -z "$MULTIMODAL_MODE" ]; then return 0; fi');
    expect(installerSh).toContain('select_multimodal_agents()');
    expect(installerSh).toContain('const supported = ["codex", "qoder"];');
    expect(installerSh).toContain('uploadMode: multimodalMode');
    expect(installerSh).toContain('if (!config.agents[id]) continue;');
    expect(installerSh).toContain('const hasTarget = !!(slsEndpoint && slsProject && slsLogstore);');
    expect(installerSh).toContain('} else if (prevStorage && slsApiKey) {');
    expect(installerSh).toContain("label: 'multimodal.storage.type'");
    expect(installerSh).toContain("label: 'multimodal.storage.target'");
    expect(installerSh).toContain("label: 'multimodal.storage.auth.mode'");
    expect(installerSh).toContain("label: 'multimodal.storage.auth.apiKey'");
    expect(installerSh).toContain('return s.slice(0, 4) + \'****\' + s.slice(-4);');
    expect(installerSh).toContain('"multimodalMode":"%s"');
  });

  it('PowerShell installer accepts -MultimodalMode and writes uploadMode', () => {
    expect(installerPs1).toContain('[string]$MultimodalMode');
    expect(installerPs1).toContain('multimodalMode');
    expect(installerPs1).toContain('-MultimodalMode is only supported with install');
    expect(installerPs1).toContain('@("none", "input", "output", "tool", "both")');
    expect(installerPs1).toContain('if (-not $script:MultimodalMode) { return }');
    expect(installerPs1).toContain('function Select-MultimodalAgents');
    expect(installerPs1).toContain('const supported = ["codex", "qoder"];');
    expect(installerPs1).toContain('uploadMode: opts.multimodalMode');
    expect(installerPs1).toContain('if (!config.agents[id]) continue;');
    expect(installerPs1).toContain('const hasTarget = !!(opts.slsEndpoint && opts.slsProject && opts.slsLogstore);');
    expect(installerPs1).toContain('} else if (prevStorage && opts.slsApiKey) {');
    expect(installerPs1).toContain("label: 'multimodal.storage.type'");
    expect(installerPs1).toContain("label: 'multimodal.storage.target'");
    expect(installerPs1).toContain("label: 'multimodal.storage.auth.mode'");
    expect(installerPs1).toContain("label: 'multimodal.storage.auth.apiKey'");
    expect(installerPs1).toContain('return s.slice(0, 4) + \'****\' + s.slice(-4);');
    expect(installerPs1).toContain('multimodalMode = $script:MultimodalMode');
  });
});

function extractShWriteConfigJs(configPath, dataDir, sls = {}) {
  const fn = installerSh.slice(
    installerSh.indexOf('write_config() {'),
    installerSh.indexOf('install_loongsuite_pilot_command() {'),
  );
  const start = fn.indexOf("const fs = require('fs');\n");
  const end = fn.indexOf("fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\\n');\n");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return fn
    .slice(start, end + "fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\\n');\n".length)
    .replaceAll("'$config_file'", JSON.stringify(configPath))
    .replaceAll("'$DATA_DIR'", JSON.stringify(dataDir))
    .replaceAll('${SLS_ENDPOINT}', sls.endpoint ?? '')
    .replaceAll('${SLS_PROJECT}', sls.project ?? '')
    .replaceAll('${SLS_LOGSTORE}', sls.logstore ?? '')
    .replaceAll('${SLS_AK_ID}', '')
    .replaceAll('${SLS_AK_SECRET}', '')
    .replaceAll('${LOG_LEVEL}', '')
    .replaceAll('${USER_ID}', '')
    .replaceAll('${COLLECT_LOG}', '')
    .replaceAll('${COLLECT_TRACE}', '')
    .replaceAll('${CMS_LICENSE_KEY}', '')
    .replaceAll('${CMS_ENDPOINT}', '')
    .replaceAll('${CMS_WORKSPACE}', '')
    .replaceAll('${SERVICE_NAME_PREFIX}', '')
    .replaceAll('${MASK_MODE}', '')
    .replaceAll('${MASK_TYPES}', '');
}

function extractPsWriteConfigJs() {
  const fn = installerPs1.slice(
    installerPs1.indexOf('function Write-Config {'),
    installerPs1.indexOf('# QoderWork-family runtime wrapper:'),
  );
  const start = fn.indexOf("const fs = require('fs');\n");
  const end = fn.indexOf("fs.writeFileSync(opts.configPath, JSON.stringify(config, null, 2) + '\\n');\n");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return fn
    .slice(start, end + "fs.writeFileSync(opts.configPath, JSON.stringify(config, null, 2) + '\\n');\n".length)
    .replace('fs.readFileSync(process.argv[1]', 'fs.readFileSync(process.argv[2]');
}

const enabledAgents = {
  agents: {
    codex: { enabled: true },
    qoder: { enabled: true },
  },
};

const completeSls = {
  endpoint: 'cn-hangzhou.log.aliyuncs.com',
  project: 'agentloop-example',
  logstore: 'agent-event',
  apiKey: 'test-sls-api-key',
};

function runWriteConfig(platform, multimodalMode, existing, {
  selectedAgents = '',
  probeAgents = [],
  multimodalAgents = '',
  sls = {},
} = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'pilot-mm-data-'));
  const configPath = resolve(root, 'config.json');
  const probeJson = JSON.stringify(probeAgents);
  try {
    if (existing !== undefined) writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n');
    const source = platform === 'bash'
      ? extractShWriteConfigJs(configPath, root, sls)
      : extractPsWriteConfigJs();
    const scriptPath = resolve(root, 'write-config.js');
    writeFileSync(scriptPath, source);
    if (platform === 'powershell-js') {
      const optsPath = resolve(root, 'options.json');
      writeFileSync(optsPath, JSON.stringify({
        configPath,
        dataDir: root,
        multimodalMode,
        multimodalAgents,
        selectedAgents,
        probeResult: probeJson,
        slsEndpoint: sls.endpoint ?? '',
        slsProject: sls.project ?? '',
        slsLogstore: sls.logstore ?? '',
        slsApiKey: sls.apiKey ?? '',
      }));
      const result = spawnSync(process.execPath, [scriptPath, optsPath], { encoding: 'utf8' });
      const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : undefined;
      return { ...result, config };
    }
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      input: probeJson,
      env: {
        ...process.env,
        LP_MULTIMODAL_MODE: multimodalMode,
        LP_MULTIMODAL_AGENTS: multimodalAgents,
        LP_SELECTED_AGENTS: selectedAgents,
        LP_SLS_API_KEY: sls.apiKey ?? '',
        LP_DASHBOARD_PORT: '',
        LP_AGENT_SELECTION_EXPLICIT: selectedAgents ? '1' : '0',
      },
    });
    const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : undefined;
    return { ...result, config };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('installer write_config multimodal-mode', () => {
  for (const platform of ['bash', 'powershell-js']) {
    describe(platform, () => {
      it('writes the same mode onto listed existing agents and skips unknown ids', () => {
        const result = runWriteConfig(platform, 'both', enabledAgents, {
          multimodalAgents: 'codex,foo',
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.codex.multimodal).toEqual({ uploadMode: 'both' });
        expect(result.config.agents.qoder.multimodal).toBeUndefined();
        expect(result.config.agents.foo).toBeUndefined();
        expect(result.config.multimodal).toBeUndefined();
      });

      it('keeps allowedRootPaths and enabled when merging', () => {
        const result = runWriteConfig(platform, 'input', {
          agents: {
            qoder: {
              enabled: false,
              multimodal: { uploadMode: 'none', allowedRootPaths: ['~/workspace'] },
            },
          },
        }, { multimodalAgents: 'qoder' });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.qoder).toEqual({
          enabled: false,
          multimodal: { uploadMode: 'input', allowedRootPaths: ['~/workspace'] },
        });
      });

      it('does not write multimodal when the mode is omitted', () => {
        const result = runWriteConfig(platform, '', {
          agents: { qoder: { enabled: true } },
        }, { multimodalAgents: 'qoder' });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.qoder).toEqual({ enabled: true });
      });

      it('writes uploadMode only after --agents has created the entry', () => {
        const result = runWriteConfig(platform, 'both', undefined, {
          selectedAgents: 'codex',
          multimodalAgents: 'codex,foo',
          probeAgents: [{ id: 'codex' }, { id: 'cursor' }],
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.codex).toEqual({
          enabled: true,
          multimodal: { uploadMode: 'both' },
        });
        expect(result.config.agents.foo).toBeUndefined();
        expect(result.config.agents.cursor).toEqual({ enabled: false });
      });

      it('writes multimodal.storage from the four SLS flags when an agent is enabled', () => {
        const result = runWriteConfig(platform, 'both', {
          ...enabledAgents,
          multimodal: { extra: true },
        }, {
          multimodalAgents: 'codex',
          sls: completeSls,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.multimodal).toEqual({
          extra: true,
          storage: {
            type: 'sls',
            target: {
              endpoint: completeSls.endpoint,
              project: completeSls.project,
              logstore: completeSls.logstore,
            },
            auth: { mode: 'apiKey', apiKey: completeSls.apiKey },
          },
        });
      });

      it('does not write multimodal.storage when there is no existing storage and the four-tuple is incomplete', () => {
        const result = runWriteConfig(platform, 'both', enabledAgents, {
          multimodalAgents: 'codex',
          sls: { ...completeSls, apiKey: '' },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.codex.multimodal).toEqual({ uploadMode: 'both' });
        expect(result.config.multimodal).toBeUndefined();
      });

      it('updates only auth when existing storage is present and only apiKey is passed', () => {
        const result = runWriteConfig(platform, 'both', {
          ...enabledAgents,
          multimodal: {
            extra: true,
            storage: {
              type: 'sls',
              target: {
                endpoint: 'old.example.com',
                project: 'old-project',
                logstore: 'old-logstore',
              },
              auth: { mode: 'apiKey', apiKey: 'old-key' },
            },
          },
        }, {
          multimodalAgents: 'codex',
          sls: { apiKey: 'new-key' },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.multimodal).toEqual({
          extra: true,
          storage: {
            type: 'sls',
            target: {
              endpoint: 'old.example.com',
              project: 'old-project',
              logstore: 'old-logstore',
            },
            auth: { mode: 'apiKey', apiKey: 'new-key' },
          },
        });
      });

      it('replaces only target when existing storage is present and the three dest flags are set', () => {
        const result = runWriteConfig(platform, 'both', {
          ...enabledAgents,
          multimodal: {
            storage: {
              type: 'sls',
              target: {
                endpoint: 'old.example.com',
                project: 'old-project',
                logstore: 'old-logstore',
              },
              auth: { mode: 'apiKey', apiKey: 'keep-key' },
            },
          },
        }, {
          multimodalAgents: 'codex',
          sls: {
            endpoint: completeSls.endpoint,
            project: completeSls.project,
            logstore: completeSls.logstore,
          },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.multimodal.storage).toEqual({
          type: 'sls',
          target: {
            endpoint: completeSls.endpoint,
            project: completeSls.project,
            logstore: completeSls.logstore,
          },
          auth: { mode: 'apiKey', apiKey: 'keep-key' },
        });
      });

      it('ignores a lone dest flag and leaves existing storage unchanged', () => {
        const existing = {
          type: 'sls',
          target: {
            endpoint: 'old.example.com',
            project: 'old-project',
            logstore: 'old-logstore',
          },
          auth: { mode: 'apiKey', apiKey: 'keep-key' },
        };
        const result = runWriteConfig(platform, 'both', {
          ...enabledAgents,
          multimodal: { storage: existing },
        }, {
          multimodalAgents: 'codex',
          sls: { endpoint: completeSls.endpoint },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.multimodal.storage).toEqual(existing);
      });

      it('writes none onto listed agents only and still writes storage from SLS flags', () => {
        const result = runWriteConfig(platform, 'none', {
          agents: {
            codex: { enabled: true, multimodal: { uploadMode: 'both', allowedRootPaths: ['~/workspace'] } },
            qoder: { enabled: true, multimodal: { uploadMode: 'input' } },
          },
        }, {
          multimodalAgents: 'codex',
          sls: completeSls,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.codex.multimodal).toEqual({
          uploadMode: 'none',
          allowedRootPaths: ['~/workspace'],
        });
        expect(result.config.agents.qoder.multimodal).toEqual({ uploadMode: 'input' });
        expect(result.config.multimodal.storage).toEqual({
          type: 'sls',
          target: {
            endpoint: completeSls.endpoint,
            project: completeSls.project,
            logstore: completeSls.logstore,
          },
          auth: { mode: 'apiKey', apiKey: completeSls.apiKey },
        });
      });

      it('writes storage from SLS flags when multimodal-mode is omitted', () => {
        const result = runWriteConfig(platform, '', enabledAgents, {
          sls: completeSls,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.codex.multimodal).toBeUndefined();
        expect(result.config.multimodal.storage.auth.apiKey).toBe(completeSls.apiKey);
      });
    });
  }
});

function runAutoSelect(source, probeAgents, selectedAgents) {
  const marker = 'const supported = ["codex", "qoder"];';
  const start = source.indexOf(marker);
  const writeCall = 'process.stdout.write(ids.join(","));';
  const end = source.indexOf(writeCall, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const js = `const fs = require("fs");\n${source.slice(start, end + writeCall.length)}`;
  const result = spawnSync(process.execPath, ['-e', js], {
    encoding: 'utf8',
    input: JSON.stringify(probeAgents),
    env: { ...process.env, LP_SELECTED_AGENTS: selectedAgents },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe('multimodal probe after agent selection', () => {
  for (const [platform, source] of [['bash', installerSh], ['powershell-js', installerPs1]]) {
    it(`${platform} keeps detected ∩ selected ∩ supported`, () => {
      expect(runAutoSelect(source, [
        { id: 'codex', detected: true },
        { id: 'qoder', detected: false },
        { id: 'cursor', detected: true },
      ], 'codex,qoder,cursor')).toBe('codex');
    });
  }
});

function extractConfirmJs(source, fnMarker) {
  const fn = source.slice(source.indexOf(fnMarker));
  const start = fn.indexOf("const fs = require('fs');\n");
  const log = "console.log(c.label + ': ' + c.oldVal + ' -> ' + c.newVal);";
  const logAt = fn.indexOf(log);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(logAt).toBeGreaterThan(start);
  const afterLog = fn.slice(logAt + log.length);
  return fn.slice(start, logAt + log.length + afterLog.indexOf('}') + 1);
}

function runConfirmDiff(source, fnMarker, existing, newVals) {
  const root = mkdtempSync(resolve(tmpdir(), 'pilot-mm-confirm-'));
  const configPath = resolve(root, 'config.json');
  try {
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n');
    const { slsApiKey = '', ...jsonVals } = newVals;
    const result = spawnSync(process.execPath, ['-e', extractConfirmJs(source, fnMarker), configPath, JSON.stringify(jsonVals)], {
      encoding: 'utf8',
      env: { ...process.env, LP_SLS_API_KEY: slsApiKey },
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const confirmNewVals = {
  slsEndpoint: '',
  slsProject: '',
  slsLogstore: '',
  slsMode: '',
  cmsLicenseKey: '',
  cmsEndpoint: '',
  cmsWorkspace: '',
  serviceNamePrefix: '',
  dashboardPort: '',
  maskMode: '',
  maskTypes: '',
  multimodalMode: '',
};

const ossStorage = {
  type: 'oss',
  target: { endpoint: 'oss.example.com', storageBasePath: 'oss://bucket/prefix' },
  auth: { mode: 'ak', accessKeyId: 'id', accessKeySecret: 'secret' },
};

describe('confirm_config_overwrite multimodal.storage', () => {
  for (const [platform, source, fnMarker] of [
    ['bash', installerSh, 'confirm_config_overwrite() {'],
    ['powershell-js', installerPs1, 'function Confirm-ConfigOverwrite {'],
  ]) {
    describe(platform, () => {
      it('shows type and target when existing independent storage would be replaced', () => {
        const lines = runConfirmDiff(source, fnMarker, { multimodal: { storage: ossStorage } }, {
          ...confirmNewVals,
          slsEndpoint: completeSls.endpoint,
          slsProject: completeSls.project,
          slsLogstore: completeSls.logstore,
          slsMode: 'apiKey',
          slsApiKey: completeSls.apiKey,
          multimodalMode: 'both',
        });
        expect(lines).toContain(`multimodal.storage.type: oss -> sls`);
        expect(lines).toContain(
          `multimodal.storage.target: ${JSON.stringify(ossStorage.target)} -> ${JSON.stringify({
            endpoint: completeSls.endpoint,
            project: completeSls.project,
            logstore: completeSls.logstore,
          })}`,
        );
        expect(lines).toContain('multimodal.storage.auth.mode: ak -> apiKey');
        expect(lines.join('\n')).not.toContain(ossStorage.auth.accessKeySecret);
        expect(lines.join('\n')).not.toMatch(/auth\.apiKey:/);
      });

      it('shows auth.mode when existing AK storage would switch to apiKey', () => {
        const lines = runConfirmDiff(source, fnMarker, {
          multimodal: {
            storage: {
              type: 'sls',
              target: {
                endpoint: 'old.example.com',
                project: 'old-project',
                logstore: 'old-logstore',
              },
              auth: { mode: 'ak', accessKeyId: 'LTAIxxxx', accessKeySecret: 'secret-ak' },
            },
          },
        }, {
          ...confirmNewVals,
          slsMode: 'apiKey',
          slsApiKey: 'newkey34token',
        });
        expect(lines).toEqual(['multimodal.storage.auth.mode: ak -> apiKey']);
        expect(lines.join('\n')).not.toContain('secret-ak');
        expect(lines.join('\n')).not.toContain('newkey34token');
      });

      it('masks apiKey as prefix****suffix when both sides are apiKey', () => {
        const oldKey = 'oldkey12secret';
        const newKey = 'newkey34token';
        const lines = runConfirmDiff(source, fnMarker, {
          multimodal: {
            storage: {
              type: 'sls',
              target: {
                endpoint: 'old.example.com',
                project: 'old-project',
                logstore: 'old-logstore',
              },
              auth: { mode: 'apiKey', apiKey: oldKey },
            },
          },
        }, {
          ...confirmNewVals,
          slsMode: 'apiKey',
          multimodalMode: 'both',
          slsApiKey: newKey,
        });
        expect(lines).toContain('multimodal.storage.auth.apiKey: oldk****cret -> newk****oken');
        expect(lines.join('\n')).not.toContain(oldKey);
        expect(lines.join('\n')).not.toContain(newKey);
      });

      it('does not show multimodal rows when dest is incomplete and no new key is passed', () => {
        const existing = {
          multimodal: {
            storage: {
              type: 'sls',
              target: {
                endpoint: 'old.example.com',
                project: 'old-project',
                logstore: 'old-logstore',
              },
              auth: { mode: 'apiKey', apiKey: 'old-key' },
            },
          },
        };
        expect(runConfirmDiff(source, fnMarker, existing, {
          ...confirmNewVals,
          slsMode: 'apiKey',
          multimodalMode: 'both',
        }).filter(line => line.startsWith('multimodal.'))).toEqual([]);
      });

      it('shows storage diffs when multimodal-mode is omitted', () => {
        const lines = runConfirmDiff(source, fnMarker, { multimodal: { storage: ossStorage } }, {
          ...confirmNewVals,
          slsEndpoint: completeSls.endpoint,
          slsProject: completeSls.project,
          slsLogstore: completeSls.logstore,
          slsMode: 'apiKey',
          slsApiKey: completeSls.apiKey,
        });
        expect(lines).toContain('multimodal.storage.type: oss -> sls');
        expect(lines).toContain('multimodal.storage.auth.mode: ak -> apiKey');
      });
    });
  }
});
