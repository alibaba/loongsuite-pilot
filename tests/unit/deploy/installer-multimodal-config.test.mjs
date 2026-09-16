import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const installerSh = readFileSync(resolve('deploy', 'installer-opensource.sh'), 'utf8');
const installerPs1 = readFileSync(resolve('deploy', 'installer-opensource.ps1'), 'utf8');

describe('public installer multimodal agent flags', () => {
  it('shell installer accepts --multimodal-agents and writes uploadMode', () => {
    expect(installerSh).toContain('MULTIMODAL_AGENTS=""');
    expect(installerSh).toContain('--multimodal-agents)');
    expect(installerSh).toContain('--multimodal-agents=*)');
    expect(installerSh).toContain('LP_MULTIMODAL_AGENTS="$MULTIMODAL_AGENTS"');
    expect(installerSh).toContain("const mode = colon === -1 ? 'both' : raw.slice(colon + 1).trim();");
    expect(installerSh).toContain('uploadMode: mode');
    expect(installerSh).toContain('--multimodal-agents is only supported with install');
    expect(installerSh).toContain("['none', 'input', 'output', 'tool', 'both'].includes(mode)");
    expect(installerSh).toContain('if (!config.agents[id]) continue;');
    expect(installerSh).toContain('select_multimodal_agents()');
    expect(installerSh).toContain('const supported = ["codex", "qoder"];');
    expect(installerSh).toContain('if (mode !== \'none\') multimodalEnabled++');
    expect(installerSh).toContain('if (multimodalEnabled && slsEndpoint && slsProject && slsLogstore && slsApiKey)');
    expect(installerSh).toContain("auth: { mode: 'apiKey', apiKey: slsApiKey }");
  });

  it('PowerShell installer accepts -MultimodalAgents and writes uploadMode', () => {
    expect(installerPs1).toContain('[string]$MultimodalAgents');
    expect(installerPs1).toContain('multimodalAgents');
    expect(installerPs1).toContain("const mode = colon === -1 ? 'both' : raw.slice(colon + 1).trim();");
    expect(installerPs1).toContain('uploadMode: mode');
    expect(installerPs1).toContain('-MultimodalAgents is only supported with install');
    expect(installerPs1).toContain("['none', 'input', 'output', 'tool', 'both'].includes(mode)");
    expect(installerPs1).toContain('if (!config.agents[id]) continue;');
    expect(installerPs1).toContain('function Select-MultimodalAgents');
    expect(installerPs1).toContain('const supported = ["codex", "qoder"];');
    expect(installerPs1).toContain('if (mode !== \'none\') multimodalEnabled++');
    expect(installerPs1).toContain('if (multimodalEnabled && opts.slsEndpoint && opts.slsProject && opts.slsLogstore && opts.slsApiKey)');
    expect(installerPs1).toContain("auth: { mode: 'apiKey', apiKey: opts.slsApiKey }");
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

const handwrittenStorage = {
  type: 'oss',
  target: {
    endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
    storageBasePath: 'oss://bucket/mm',
  },
  auth: { mode: 'ak', accessKeyId: 'ak', accessKeySecret: 'sk' },
};

function runWriteConfig(platform, multimodalAgents, existing, {
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

describe('installer write_config multimodal-agents', () => {
  for (const platform of ['bash', 'powershell-js']) {
    describe(platform, () => {
      it('defaults bare agent ids to both', () => {
        const result = runWriteConfig(platform, 'codex,qoder', enabledAgents);
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.codex.multimodal).toEqual({ uploadMode: 'both' });
        expect(result.config.agents.qoder.multimodal).toEqual({ uploadMode: 'both' });
        expect(result.config.multimodal).toBeUndefined();
      });

      it('honors per-agent mode and mixed defaults', () => {
        const result = runWriteConfig(platform, 'codex:both,qoder:input', enabledAgents);
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.codex.multimodal.uploadMode).toBe('both');
        expect(result.config.agents.qoder.multimodal.uploadMode).toBe('input');
      });

      it('keeps allowedRootPaths and enabled when merging', () => {
        const result = runWriteConfig(platform, 'qoder:input', {
          agents: {
            qoder: {
              enabled: false,
              multimodal: { uploadMode: 'none', allowedRootPaths: ['~/workspace'] },
            },
          },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.qoder).toEqual({
          enabled: false,
          multimodal: { uploadMode: 'input', allowedRootPaths: ['~/workspace'] },
        });
      });

      it('does not write multimodal when the flag is empty', () => {
        const result = runWriteConfig(platform, '', {
          agents: { qoder: { enabled: true } },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.qoder).toEqual({ enabled: true });
      });

      it('skips an empty mode after the colon', () => {
        const result = runWriteConfig(platform, 'codex:', enabledAgents);
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.codex).toEqual({ enabled: true });
      });

      it('skips ids that are not already in config.agents', () => {
        const result = runWriteConfig(platform, 'codex,foo', enabledAgents);
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.codex.multimodal).toEqual({ uploadMode: 'both' });
        expect(result.config.agents.foo).toBeUndefined();
      });

      it('does not create an agent entry when config.agents is empty', () => {
        const result = runWriteConfig(platform, 'codex');
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.codex).toBeUndefined();
      });

      it('writes uploadMode only after --agents has created the entry', () => {
        const result = runWriteConfig(platform, 'codex,foo', undefined, {
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

      it('skips an unknown uploadMode', () => {
        const result = runWriteConfig(platform, 'codex:botn,qoder:input', enabledAgents);
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.codex).toEqual({ enabled: true });
        expect(result.config.agents.qoder.multimodal).toEqual({ uploadMode: 'input' });
      });

      it('writes multimodal.storage from the four SLS flags when an agent is enabled', () => {
        const result = runWriteConfig(platform, 'codex:both', enabledAgents, { sls: completeSls });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.multimodal).toEqual({
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

      it('does not write multimodal.storage when apiKey is missing', () => {
        const result = runWriteConfig(platform, 'codex:both', enabledAgents, {
          sls: { ...completeSls, apiKey: '' },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.codex.multimodal).toEqual({ uploadMode: 'both' });
        expect(result.config.multimodal).toBeUndefined();
      });

      it('does not write multimodal.storage when project is missing', () => {
        const result = runWriteConfig(platform, 'codex:both', enabledAgents, {
          sls: { ...completeSls, project: '' },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.codex.multimodal).toEqual({ uploadMode: 'both' });
        expect(result.config.multimodal).toBeUndefined();
      });

      it('does not write multimodal.storage when every id is skipped', () => {
        const result = runWriteConfig(platform, 'foo:both', enabledAgents, { sls: completeSls });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.foo).toBeUndefined();
        expect(result.config.multimodal).toBeUndefined();
      });

      it('does not write multimodal.storage when the only written mode is none', () => {
        const result = runWriteConfig(platform, 'codex:none', enabledAgents, { sls: completeSls });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.codex.multimodal).toEqual({ uploadMode: 'none' });
        expect(result.config.multimodal).toBeUndefined();
      });

      it('keeps handwritten multimodal.storage when the SLS four-tuple is incomplete', () => {
        const result = runWriteConfig(platform, 'codex:both', {
          ...enabledAgents,
          multimodal: { storage: handwrittenStorage },
        }, {
          sls: { ...completeSls, apiKey: '' },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.config.agents.codex.multimodal).toEqual({ uploadMode: 'both' });
        expect(result.config.multimodal).toEqual({ storage: handwrittenStorage });
      });

      it('overwrites handwritten storage and keeps sibling keys when the four-tuple is complete', () => {
        const result = runWriteConfig(platform, 'codex:both', {
          ...enabledAgents,
          multimodal: { extra: true, storage: handwrittenStorage },
        }, { sls: completeSls });
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

describe('multimodal auto-select after agent selection', () => {
  for (const [platform, source] of [['bash', installerSh], ['powershell-js', installerPs1]]) {
    describe(platform, () => {
      it('enables detected and selected supported agents only', () => {
        expect(runAutoSelect(source, [
          { id: 'codex', detected: true },
          { id: 'qoder', detected: true },
          { id: 'cursor', detected: true },
        ], 'codex,qoder,cursor')).toBe('codex,qoder');
      });

      it('skips supported agents that were not selected', () => {
        expect(runAutoSelect(source, [
          { id: 'codex', detected: true },
          { id: 'qoder', detected: true },
        ], 'qoder')).toBe('qoder');
      });

      it('skips supported agents that were not detected', () => {
        expect(runAutoSelect(source, [
          { id: 'codex', detected: false },
          { id: 'qoder', detected: true },
        ], 'codex,qoder')).toBe('qoder');
      });
    });
  }
});
