import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDefLoader } from '../../../src/deployment/agent-def-loader.js';
import { DoubaoWorkInput } from '../../../src/inputs/doubao-work/doubao-work-input.js';
import { detectAgent } from '../../../src/deployment/detect-utils.js';
import { DeploymentManager } from '../../../src/deployment/deployment-manager.js';
import { collectUnmet, deployExitCode } from '../../../src/deployment/deploy-command.js';
import { probeAgentDefinition } from '../../../src/deployment/cli-probe-detector.js';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async () => ({ ...await vi.importActual<typeof import('node:os')>('node:os'), homedir: () => fixture.home }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const temporary: string[] = [];
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe.each(['darwin', 'win32'] as const)('Doubao definition paths on %s', target => {
  it.each([true, false].flatMap(overridden => ([undefined, 'doubao-work', 'doubao'] as const).map(client => ({ overridden, client }))))('matches the selected collector source: %j', async ({ overridden, client }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'doubao-definition-')); temporary.push(root);
    fixture.home = root;
    await writeFile(path.join(root, 'doubao-work.json'), await readFile(path.resolve('agents.d/doubao-work.json')));
    const loader = new AgentDefLoader({ builtinDir: root, localDir: path.join(root, 'absent'), pilotDir: root, dataDir: root,
      doubaoWork: { client } });
    Object.defineProperty(process, 'platform', { value: target });
    vi.stubEnv('LOCALAPPDATA', overridden ? 'D:\\Synthetic Local' : '');
    if (!overridden) delete process.env.LOCALAPPDATA;
    try {
      const defs = await loader.load();
      const expected = DoubaoWorkInput.defaultLogDir(client)!.replace(/\\/g, '/');
      expect(defs[0].detection.paths.map(p => p.replace(/\\/g, '/'))).toEqual([
        expected,
      ]);
      if (target === 'win32') {
        expect(expected).toBe(path.win32.join(overridden ? 'D:\\Synthetic Local' : path.win32.join(homedir(), 'AppData', 'Local'),
          client === 'doubao' ? 'Doubao' : 'DoubaoWork', 'User Data', 'sdk_storage', 'log').replace(/\\/g, '/'));
      }
    } finally { Object.defineProperty(process, 'platform', platform); }
  });
});

describe('Doubao installer and deployment select the same source as the input', () => {
  it('uses an explicit log override for detection without changing the selected native product', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'doubao-detect-override-')); temporary.push(root);
    fixture.home = root;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    await writeFile(path.join(root, 'doubao-work.json'), await readFile(path.resolve('agents.d/doubao-work.json')));
    const logDir = path.join(root, 'custom-logs'); await mkdir(logDir);
    await writeFile(path.join(logDir, 'saman_frontend_2026.1111.0.log'), '');
    const loader = new AgentDefLoader({ builtinDir: root, localDir: path.join(root, 'absent'), pilotDir: root, dataDir: root,
      doubaoWork: { client: 'doubao', logDir } });
    const [def] = await loader.load();
    expect(def.detection.paths).toEqual([logDir]);
    expect(await detectAgent(def.detection)).toBe(true);
    expect(await DoubaoWorkInput.checkAvailability(logDir, 'doubao')).toBe(true);
    expect(DoubaoWorkInput.defaultLogDir('doubao')).not.toBe(logDir);
  });

  it.each([
    { installed: 'Doubao', client: undefined, detected: false },
    { installed: 'Doubao', client: 'doubao' as const, detected: true },
    { installed: 'DoubaoWork', client: undefined, detected: true },
    { installed: 'DoubaoWork', client: 'doubao' as const, detected: false },
  ])('uses the configured product, including App-only machines: %j', async ({ installed, client, detected }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'doubao-detection-')); temporary.push(root);
    fixture.home = root;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const definitions = path.join(root, 'definitions'); await mkdir(definitions);
    await writeFile(path.join(definitions, 'doubao-work.json'), await readFile(path.resolve('agents.d/doubao-work.json')));
    const logs = path.join(root, 'Library', 'Application Support', installed, 'sdk_storage', 'log');
    await mkdir(logs, { recursive: true });
    await writeFile(path.join(logs, 'saman_frontend_2026.1111.0.log'), '');
    await mkdir(path.join(root, 'pilot'));
    const manager = new DeploymentManager({ pilotDir: root, dataDir: path.join(root, 'pilot'), builtinAgentsDir: definitions,
      doubaoWork: { client } });
    const defs = await manager.loadDefinitions(), def = defs.find(def => def.id === 'doubao-work')!;
    expect(await detectAgent(def.detection)).toBe(detected);
    expect((await probeAgentDefinition(def, { installer: true })).detected).toBe(detected);
    expect(await DoubaoWorkInput.checkAvailability(undefined, client)).toBe(detected);
    const results = await manager.deployAll();
    expect(deployExitCode(results, collectUnmet(['doubao-work'], new Set(['doubao-work']), results), false)).toBe(detected ? 0 : 1);
  });
});
