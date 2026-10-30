import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDefLoader } from '../../../src/deployment/agent-def-loader.js';
import { DoubaoWorkInput } from '../../../src/inputs/doubao-work/doubao-work-input.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const temporary: string[] = [];
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe.each(['darwin', 'win32'] as const)('Doubao definition paths on %s', target => {
  it.each([true, false])('matches the collector default with LOCALAPPDATA set=%s', async overridden => {
    const root = await mkdtemp(path.join(tmpdir(), 'doubao-definition-')); temporary.push(root);
    await writeFile(path.join(root, 'doubao-work.json'), await readFile(path.resolve('agents.d/doubao-work.json')));
    const loader = new AgentDefLoader({ builtinDir: root, localDir: path.join(root, 'absent'), pilotDir: root, dataDir: root });
    Object.defineProperty(process, 'platform', { value: target });
    vi.stubEnv('LOCALAPPDATA', overridden ? 'D:\\Synthetic Local' : '');
    if (!overridden) delete process.env.LOCALAPPDATA;
    try {
      const defs = await loader.load();
      const expected = DoubaoWorkInput.defaultLogDir()!.replace(/\\/g, '/');
      expect(defs[0].detection.paths.map(p => p.replace(/\\/g, '/'))).toEqual([
        expected, DoubaoWorkInput.defaultLogDir('doubao')!.replace(/\\/g, '/'),
      ]);
      if (target === 'win32') {
        expect(expected).toBe(path.win32.join(overridden ? 'D:\\Synthetic Local' : path.win32.join(homedir(), 'AppData', 'Local'),
          'DoubaoWork', 'User Data', 'sdk_storage', 'log').replace(/\\/g, '/'));
      }
    } finally { Object.defineProperty(process, 'platform', platform); }
  });
});
