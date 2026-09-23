import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgentDefLoader } from '../../../src/deployment/agent-def-loader.js';

describe('QwenPaw native directory deployment definition', () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([undefined, '/tmp/isolated-qwenpaw working'])('resolves working directory %s independently of Pilot dataDir', async working => {
    if (working === undefined) vi.stubEnv('QWENPAW_WORKING_DIR', '');
    else vi.stubEnv('QWENPAW_WORKING_DIR', working);
    const definitions = await new AgentDefLoader({
      builtinDir: path.resolve('agents.d'), localDir: '/nonexistent/pilot-local-definitions',
      pilotDir: '/opt/pilot', dataDir: '/var/pilot-data',
    }).load();
    const def = definitions.find(def => def.id === 'qwenpaw')!;
    const expected = working ?? path.join(os.homedir(), '.qwenpaw');
    expect(def.deployMode).toBe('directory-plugin');
    expect(def.detection.paths).toContain(expected);
    expect(def.directoryPlugin?.sourceDir).toBe('/opt/pilot/assets/plugins/qwenpaw/loongsuite-pilot');
    expect(def.directoryPlugin?.targetDir).toBe(path.join(expected, 'plugins/loongsuite-pilot'));
    expect(def.directoryPlugin?.activation).toBeUndefined();
  });
});
