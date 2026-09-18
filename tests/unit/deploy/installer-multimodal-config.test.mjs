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
    expect(installerSh).toContain('MULTIMODAL_MODE_SET=0');
    expect(installerSh).toContain('MULTIMODAL_SUPPORTED_AGENTS="codex,qoder"');
    expect(installerSh).toContain('--multimodal-mode)');
    expect(installerSh).toContain('--multimodal-mode=*)');
    expect(installerSh).toContain('MULTIMODAL_MODE="${2-}"; MULTIMODAL_MODE_SET=1; shift 2 || shift');
    expect(installerSh).toContain('MULTIMODAL_MODE="${1#*=}"; MULTIMODAL_MODE_SET=1');
    expect(installerSh).toContain('if [ "$MULTIMODAL_MODE_SET" -eq 1 ]; then');
    expect(installerSh).toContain('LP_MULTIMODAL_MODE="$MULTIMODAL_MODE"');
    expect(installerSh).toContain('LP_MULTIMODAL_SUPPORTED_AGENTS="$MULTIMODAL_SUPPORTED_AGENTS"');
    expect(installerSh).toContain('--multimodal-mode is only supported with install');
    expect(installerSh).toContain("--multimodal-mode requires 'none', 'input', 'output', or 'both'");
    expect(installerSh).toContain('requires --sls-endpoint, --sls-project, --sls-logstore, and --sls-api-key');
    expect(installerSh).toContain("none|input|output|both)");
    expect(installerSh).toContain('process.env.LP_MULTIMODAL_SUPPORTED_AGENTS');
    expect(installerSh).toContain("if (multimodalMode === 'none')");
    expect(installerSh).toContain('delete config.agents[id].multimodal');
    expect(installerSh).toContain("selected.has(id) ? multimodalMode : 'none'");
    expect(installerSh).not.toContain('listed.has');
    expect(installerSh).toContain("if (multimodalMode && multimodalMode !== 'none' && slsEndpoint && slsProject && slsLogstore && slsApiKey)");
    expect(installerSh).toContain('storage: { type: \'sls\' }');
    expect(installerSh).toContain("label: 'multimodal.storage.type'");
    expect(installerSh).toContain('"multimodalMode":"%s"');
  });

  it('PowerShell installer accepts -MultimodalMode and writes uploadMode', () => {
    expect(installerPs1).toContain('[string]$MultimodalMode');
    expect(installerPs1).toContain('[AllowEmptyString()]');
    expect(installerPs1).toContain("if ($PSBoundParameters.Keys -contains 'MultimodalMode' -and -not $MultimodalMode)");
    expect(installerPs1).toContain("-MultimodalMode requires 'none', 'input', 'output', or 'both'");
    expect(installerPs1).toContain('$script:MultimodalSupportedAgents = "codex,qoder"');
    expect(installerPs1).toContain('multimodalMode');
    expect(installerPs1).toContain('-MultimodalMode is only supported with install');
    expect(installerPs1).toContain('requires -SlsEndpoint, -SlsProject, -SlsLogstore, and -SlsApiKey');
    expect(installerPs1).toContain('@("none", "input", "output", "both")');
    expect(installerPs1).toContain('opts.multimodalSupportedAgents');
    expect(installerPs1).toContain("if (opts.multimodalMode === 'none')");
    expect(installerPs1).toContain('delete config.agents[id].multimodal');
    expect(installerPs1).toContain("selected.has(id) ? opts.multimodalMode : 'none'");
    expect(installerPs1).not.toContain('listed.has');
    expect(installerPs1).toContain("if (opts.multimodalMode && opts.multimodalMode !== 'none' && opts.slsEndpoint && opts.slsProject && opts.slsLogstore && opts.slsApiKey)");
    expect(installerPs1).toContain('storage: { type: \'sls\' }');
    expect(installerPs1).toContain("label: 'multimodal.storage.type'");
    expect(installerPs1).toContain('multimodalMode = $script:MultimodalMode');
  });

  it('PowerShell Write-Config aborts on a nonzero node exit', () => {
    const fn = installerPs1.slice(
      installerPs1.indexOf('function Write-Config {'),
      installerPs1.indexOf('# QoderWork-family runtime wrapper:'),
    );
    const lines = fn.split('\n');
    const nodeEnd = lines.indexOf("'@ $cfgTmp");
    expect(nodeEnd).toBeGreaterThan(0);
    expect(lines[nodeEnd + 1].trim()).toBe('$cfgExit = $LASTEXITCODE');
    expect(fn).toMatch(/if \(\$cfgExit -ne 0\) \{/);
    expect(fn).toContain('Failed to write config');
    expect(fn).toContain('Remove-PilotPathQuietly $cfgTmp');
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
    .replaceAll('${SLS_AK_ID}', sls.akId ?? '')
    .replaceAll('${SLS_AK_SECRET}', sls.akSecret ?? '')
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
        multimodalSupportedAgents: 'codex,qoder',
        selectedAgents,
        probeResult: probeJson,
        slsEndpoint: sls.endpoint ?? '',
        slsProject: sls.project ?? '',
        slsLogstore: sls.logstore ?? '',
        slsAkId: sls.akId ?? '',
        slsAkSecret: sls.akSecret ?? '',
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
        LP_MULTIMODAL_SUPPORTED_AGENTS: 'codex,qoder',
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
      it('writes the same mode onto this install selected ∩ supported and skips unknown ids', () => {
        const result = runWriteConfig(platform, 'both', {
          agents: {
            ...enabledAgents.agents,
            cursor: { enabled: true },
          },
        }, { selectedAgents: 'codex,qoder,cursor' });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.codex.multimodal).toEqual({ uploadMode: 'both' });
        expect(result.config.agents.qoder.multimodal).toEqual({ uploadMode: 'both' });
        expect(result.config.agents.cursor.multimodal).toBeUndefined();
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
        }, { selectedAgents: 'qoder' });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.qoder).toEqual({
          enabled: false,
          multimodal: { uploadMode: 'input', allowedRootPaths: ['~/workspace'] },
        });
      });

      it('does not write multimodal when the mode is omitted', () => {
        const result = runWriteConfig(platform, '', {
          agents: { qoder: { enabled: true } },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.qoder).toEqual({ enabled: true });
      });

      it('writes none onto existing supported agents that were not selected', () => {
        const result = runWriteConfig(platform, 'output', {
          agents: {
            qoder: { enabled: false },
            cursor: { enabled: true },
          },
        }, { selectedAgents: 'cursor' });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.qoder.multimodal).toEqual({ uploadMode: 'none' });
        expect(result.config.agents.cursor.multimodal).toBeUndefined();
      });

      it('keeps both on selected codex and writes none onto existing qoder both', () => {
        const result = runWriteConfig(platform, 'both', {
          agents: {
            codex: { enabled: true, multimodal: { uploadMode: 'both' } },
            qoder: { enabled: true, multimodal: { uploadMode: 'both' } },
          },
        }, { selectedAgents: 'codex' });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.codex.multimodal).toEqual({ uploadMode: 'both' });
        expect(result.config.agents.qoder.multimodal).toEqual({ uploadMode: 'none' });
      });

      it('writes uploadMode only after --agents has created the entry', () => {
        const result = runWriteConfig(platform, 'both', undefined, {
          selectedAgents: 'codex',
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

      it('writes type-only sls storage when mode is on and the SLS four-tuple is complete', () => {
        const result = runWriteConfig(platform, 'both', {
          ...enabledAgents,
          multimodal: { extra: true },
        }, {
          selectedAgents: 'codex,qoder',
          sls: completeSls,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.multimodal).toEqual({
          storage: { type: 'sls' },
        });
      });

      it('does not write storage when the SLS four-tuple is incomplete', () => {
        const result = runWriteConfig(platform, 'both', enabledAgents, {
          selectedAgents: 'codex,qoder',
          sls: { ...completeSls, apiKey: '' },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.codex.multimodal).toEqual({ uploadMode: 'both' });
        expect(result.config.multimodal).toBeUndefined();
      });

      it('replaces existing storage with type-only sls when mode is on and the four-tuple is complete', () => {
        const result = runWriteConfig(platform, 'input', {
          ...enabledAgents,
          multimodal: {
            extra: true,
            storage: {
              type: 'oss',
              target: { endpoint: 'oss.example.com', storageBasePath: 'oss://bucket/prefix' },
              auth: { mode: 'ak', accessKeyId: 'id', accessKeySecret: 'secret' },
            },
          },
        }, {
          selectedAgents: 'codex,qoder',
          sls: completeSls,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.multimodal).toEqual({
          storage: { type: 'sls' },
        });
      });

      it('deletes existing supported multimodal blocks when mode is none', () => {
        const existing = {
          type: 'oss',
          target: { endpoint: 'oss.example.com', storageBasePath: 'oss://bucket/prefix' },
          auth: { mode: 'ak', accessKeyId: 'id', accessKeySecret: 'secret' },
        };
        const result = runWriteConfig(platform, 'none', {
          agents: {
            codex: { enabled: true, multimodal: { uploadMode: 'both', allowedRootPaths: ['~/workspace'] } },
            qoder: { enabled: true, multimodal: { uploadMode: 'input' } },
            cursor: { enabled: true, multimodal: { uploadMode: 'both' } },
          },
          multimodal: { storage: existing },
        }, {
          sls: completeSls,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.codex).toEqual({ enabled: true });
        expect(result.config.agents.qoder).toEqual({ enabled: true });
        expect(result.config.agents.cursor.multimodal).toEqual({ uploadMode: 'both' });
        expect(result.config.multimodal.storage).toEqual(existing);
      });

      it('does not write storage when multimodal-mode is omitted', () => {
        const result = runWriteConfig(platform, '', enabledAgents, {
          sls: completeSls,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.codex.multimodal).toBeUndefined();
        expect(result.config.multimodal).toBeUndefined();
      });
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
    it(`${platform} shows storage.type when multimodal would rewrite it`, () => {
      const lines = runConfirmDiff(source, fnMarker, { multimodal: { storage: ossStorage } }, {
        ...confirmNewVals,
        slsEndpoint: completeSls.endpoint,
        slsProject: completeSls.project,
        slsLogstore: completeSls.logstore,
        slsMode: 'apiKey',
        slsApiKey: completeSls.apiKey,
        multimodalMode: 'both',
      });
      expect(lines).toContain('multimodal.storage.type: oss -> sls');
    });
  }
});
