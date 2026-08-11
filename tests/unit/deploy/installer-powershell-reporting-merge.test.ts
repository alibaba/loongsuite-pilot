import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const installers = [
  'deploy/installer.ps1',
  'deploy/installer-inner.ps1',
];
const tempDirs: string[] = [];

type Fixture = {
  name: string;
  initial: Record<string, unknown>;
  options: Record<string, unknown>;
  expected: Record<string, unknown>;
};

const fixtures: Fixture[] = [
  {
    name: 'missing SLS becomes a named array',
    initial: { untouched: true },
    options: {
      slsRequested: true,
      slsEndpoint: 'https://new.example.com',
      slsProject: 'new-project',
      slsLogstore: 'new-logstore',
      slsAkId: '',
      slsAkSecret: '',
      cmsRequested: false,
    },
    expected: {
      untouched: true,
      sls: [{
        name: 'user-sls',
        endpoint: 'https://new.example.com',
        project: 'new-project',
        logstore: 'new-logstore',
        mode: 'webtracking',
      }],
    },
  },
  {
    name: 'legacy object stays an object and CMS is patched',
    initial: {
      sls: {
        endpoint: 'https://old.example.com',
        project: 'old-project',
        logstore: 'old-logstore',
        mode: 'ak',
        accessKeyId: 'old-id',
        accessKeySecret: 'old-secret',
        batchMaxSize: 30,
      },
      cms: {
        licenseKey: 'keep-key',
        endpoint: 'https://old-cms.example.com',
        workspace: 'old-workspace',
        debug: true,
      },
      otlpTrace: { endpoint: 'https://keep-otlp.example.com' },
    },
    options: {
      slsRequested: true,
      slsEndpoint: 'https://new.example.com',
      slsProject: 'new-project',
      slsLogstore: 'new-logstore',
      slsAkId: '',
      slsAkSecret: '',
      cmsRequested: true,
      cmsLicenseKeySet: false,
      cmsEndpointSet: true,
      cmsWorkspaceSet: true,
      cmsLicenseKey: '',
      cmsEndpoint: 'https://new-cms.example.com',
      cmsWorkspace: '',
      collectLogSet: true,
      collectLog: 'false',
      collectTraceSet: true,
      collectTrace: 'true',
      serviceNamePrefixSet: true,
      serviceNamePrefix: 'prefix',
    },
    expected: {
      sls: {
        endpoint: 'https://new.example.com',
        project: 'new-project',
        logstore: 'new-logstore',
        mode: 'webtracking',
        batchMaxSize: 30,
      },
      cms: {
        licenseKey: 'keep-key',
        endpoint: 'https://new-cms.example.com',
        workspace: '',
        debug: true,
      },
      otlpTrace: { endpoint: 'https://keep-otlp.example.com' },
      collectLog: false,
      collectTrace: true,
      serviceNamePrefix: 'prefix',
    },
  },
  {
    name: 'duplicate user-sls entries collapse at the first matching position',
    initial: {
      sls: [
        { name: 'before', endpoint: 'https://before.example.com' },
        { name: 'user-sls', endpoint: 'https://old-1.example.com' },
        { name: 'between', endpoint: 'https://between.example.com' },
        { name: 'user-sls', endpoint: 'https://old-2.example.com' },
      ],
    },
    options: {
      slsRequested: true,
      slsEndpoint: 'https://new.example.com',
      slsProject: 'new-project',
      slsLogstore: 'new-logstore',
      slsAkId: 'new-id',
      slsAkSecret: 'new-secret',
      cmsRequested: false,
    },
    expected: {
      sls: [
        { name: 'before', endpoint: 'https://before.example.com' },
        {
          name: 'user-sls',
          endpoint: 'https://new.example.com',
          project: 'new-project',
          logstore: 'new-logstore',
          mode: 'ak',
          accessKeyId: 'new-id',
          accessKeySecret: 'new-secret',
        },
        { name: 'between', endpoint: 'https://between.example.com' },
      ],
    },
  },
];

async function extractMergeProgram(installer: string) {
  const content = await readFile(path.join(rootDir, installer), 'utf8');
  const marker = "$nodeOutput = $cfgJson | & $script:NODE_BIN -e @'\n";
  const start = content.indexOf(marker);
  const end = content.indexOf("\n'@", start + marker.length);
  if (start < 0 || end < 0) throw new Error(`merge program not found in ${installer}`);
  return content.slice(start + marker.length, end);
}

async function runFixture(installer: string, fixture: Fixture) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lp-ps-merge-'));
  tempDirs.push(tempDir);
  const configPath = path.join(tempDir, 'config.json');
  await writeFile(configPath, `${JSON.stringify(fixture.initial, null, 2)}\n`);
  const input = JSON.stringify({
    cmsLicenseKeySet: false,
    cmsEndpointSet: false,
    cmsWorkspaceSet: false,
    collectLogSet: false,
    collectTraceSet: false,
    serviceNamePrefixSet: false,
    collectLog: '',
    collectTrace: '',
    serviceNamePrefix: '',
    ...fixture.options,
    configPath,
  });

  const program = await extractMergeProgram(installer);
  const result = spawnSync(process.execPath, ['-e', program], {
    encoding: 'utf8',
    input,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe.each(installers)('%s embedded reporting merge', (installer) => {
  it.each(fixtures)('$name', async (fixture) => {
    expect(await runFixture(installer, fixture)).toEqual(fixture.expected);
  });
});
