import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgentDefLoader } from '../../../src/deployment/agent-def-loader.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('AgentDefLoader', () => {
  let tmpDir: string;
  let builtinDir: string;
  let localDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-def-loader-'));
    builtinDir = path.join(tmpDir, 'agents.d');
    localDir = path.join(tmpDir, 'agents.d.local');
    await fs.mkdir(builtinDir, { recursive: true });
    await fs.mkdir(localDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeLoader() {
    return new AgentDefLoader({
      builtinDir,
      localDir,
      pilotDir: '/opt/pilot',
      dataDir: '/home/user/.loongsuite-pilot',
    });
  }

  it('loads valid definitions from builtin directory', async () => {
    const def = {
      id: 'test-agent',
      displayName: 'Test',
      deployMode: 'hook',
      detection: { paths: ['~/.test'], commands: [] },
      hook: { settingsPath: '~/.test/settings.json', events: ['Stop'], hookCommand: 'test.sh', format: 'flat' },
    };
    await fs.writeFile(path.join(builtinDir, 'test.json'), JSON.stringify(def));

    const loader = makeLoader();
    const defs = await loader.load();

    expect(defs).toHaveLength(1);
    expect(defs[0].id).toBe('test-agent');
  });

  it('skips invalid JSON files', async () => {
    await fs.writeFile(path.join(builtinDir, 'broken.json'), '{invalid');

    const loader = makeLoader();
    const defs = await loader.load();

    expect(defs).toHaveLength(0);
  });

  it('skips definitions missing required fields', async () => {
    const def = { id: 'missing-fields' };
    await fs.writeFile(path.join(builtinDir, 'bad.json'), JSON.stringify(def));

    const loader = makeLoader();
    const defs = await loader.load();

    expect(defs).toHaveLength(0);
  });

  it('local definitions override builtin by id', async () => {
    const builtin = {
      id: 'cursor',
      displayName: 'Cursor Builtin',
      deployMode: 'hook',
      detection: { paths: ['~/.cursor'], commands: [] },
    };
    const local = {
      id: 'cursor',
      displayName: 'Cursor Local Override',
      deployMode: 'hook',
      detection: { paths: ['~/.cursor-custom'], commands: [] },
    };

    await fs.writeFile(path.join(builtinDir, 'cursor.json'), JSON.stringify(builtin));
    await fs.writeFile(path.join(localDir, 'cursor.json'), JSON.stringify(local));

    const loader = makeLoader();
    const defs = await loader.load();

    expect(defs).toHaveLength(1);
    expect(defs[0].displayName).toBe('Cursor Local Override');
  });

  it('replaces $PILOT_DIR and $PILOT_DATA variables', async () => {
    const def = {
      id: 'var-test',
      displayName: 'Var Test',
      deployMode: 'hook',
      detection: { paths: ['$PILOT_DATA/logs'], commands: [] },
      hook: {
        settingsPath: '$PILOT_DATA/settings.json',
        events: ['Stop'],
        hookCommand: '$PILOT_DIR/hooks/test.sh',
        format: 'flat',
      },
    };
    await fs.writeFile(path.join(builtinDir, 'var.json'), JSON.stringify(def));

    const loader = makeLoader();
    const defs = await loader.load();

    expect(defs[0].detection.paths[0]).toBe('/home/user/.loongsuite-pilot/logs');
    expect(defs[0].hook!.hookCommand).toBe('/opt/pilot/hooks/test.sh');
  });

  it('expands ~ to home directory', async () => {
    const def = {
      id: 'tilde-test',
      displayName: 'Tilde Test',
      deployMode: 'hook',
      detection: { paths: ['~/.cursor'], commands: [] },
    };
    await fs.writeFile(path.join(builtinDir, 'tilde.json'), JSON.stringify(def));

    const loader = makeLoader();
    const defs = await loader.load();

    expect(defs[0].detection.paths[0]).toBe(path.join(os.homedir(), '.cursor'));
  });

  it('expands ~ in nested version command candidates', async () => {
    const def = {
      id: 'candidate-test',
      displayName: 'Candidate Test',
      deployMode: 'plugin-inject',
      detection: { paths: ['~/.candidate-test'], commands: [] },
      pluginInject: {
        configPaths: ['~/.candidate-test/config.json'],
        pluginSpec: '$PILOT_DATA/plugins/candidate-test/plugin.mjs',
        pluginId: 'loongsuite-pilot-candidate-test',
        versionCheck: {
          commandCandidates: [
            ['~/.agent-bundle/wrapper/agent-cli', '--version'],
            ['agent-cli', '--version'],
          ],
          minimum: '2026.5.12',
        },
      },
    };
    await fs.writeFile(path.join(builtinDir, 'candidate-test.json'), JSON.stringify(def));

    const [loaded] = await makeLoader().load();

    expect(loaded.pluginInject?.versionCheck?.commandCandidates?.[0]?.[0]).toBe(
      path.join(os.homedir(), '.agent-bundle', 'wrapper', 'agent-cli'),
    );
    expect(loaded.pluginInject?.versionCheck?.commandCandidates?.[1]?.[0]).toBe('agent-cli');
  });

  it('resolves HERMES_HOME for directory plugins', async () => {
    const previous = process.env.HERMES_HOME;
    const previousCli = process.env.HERMES_CLI;
    process.env.HERMES_HOME = path.join(tmpDir, 'hermes-profile');
    process.env.HERMES_CLI = path.join(tmpDir, 'hermes-bin', 'hermes');
    try {
      const def = {
        id: 'hermes-agent',
        displayName: 'Hermes Agent',
        deployMode: 'directory-plugin',
        detection: { paths: ['$HERMES_HOME'], commands: ['hermes'] },
        directoryPlugin: {
          sourceDir: '$PILOT_DIR/assets/plugins/hermes-agent/loongsuite-pilot',
          targetDir: '$HERMES_HOME/plugins/loongsuite-pilot',
          activation: {
            command: '$HERMES_CLI',
            enableArgs: ['plugins', 'enable', 'loongsuite-pilot'],
          },
        },
      };
      await fs.writeFile(path.join(builtinDir, 'hermes-agent.json'), JSON.stringify(def));

      const [loaded] = await makeLoader().load();

      expect(loaded.deployMode).toBe('directory-plugin');
      expect(loaded.detection.paths[0]).toBe(path.join(tmpDir, 'hermes-profile'));
      expect(loaded.directoryPlugin?.sourceDir).toBe(
        '/opt/pilot/assets/plugins/hermes-agent/loongsuite-pilot',
      );
      expect(loaded.directoryPlugin?.targetDir).toBe(
        path.join(tmpDir, 'hermes-profile', 'plugins', 'loongsuite-pilot'),
      );
      expect(loaded.directoryPlugin?.activation?.command).toBe(
        path.join(tmpDir, 'hermes-bin', 'hermes'),
      );
    } finally {
      if (previous === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = previous;
      if (previousCli === undefined) delete process.env.HERMES_CLI;
      else process.env.HERMES_CLI = previousCli;
    }
  });

  it('falls back to the Hermes command on PATH when the bundled CLI is absent', async () => {
    const previousHome = process.env.HERMES_HOME;
    const previousCli = process.env.HERMES_CLI;
    process.env.HERMES_HOME = path.join(tmpDir, 'hermes-profile');
    delete process.env.HERMES_CLI;
    try {
      const def = {
        id: 'hermes-agent',
        displayName: 'Hermes Agent',
        deployMode: 'directory-plugin',
        detection: { paths: ['$HERMES_HOME'], commands: ['hermes'] },
        directoryPlugin: {
          sourceDir: '$PILOT_DIR/hermes-plugin',
          targetDir: '$HERMES_HOME/plugins/loongsuite-pilot',
          activation: {
            command: '$HERMES_CLI',
            enableArgs: ['plugins', 'enable', 'loongsuite-pilot'],
          },
        },
      };
      await fs.writeFile(path.join(builtinDir, 'hermes-agent.json'), JSON.stringify(def));

      const [loaded] = await makeLoader().load();

      expect(loaded.directoryPlugin?.activation?.command).toBe(
        process.platform === 'win32' ? 'hermes.exe' : 'hermes',
      );
    } finally {
      if (previousHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = previousHome;
      if (previousCli === undefined) delete process.env.HERMES_CLI;
      else process.env.HERMES_CLI = previousCli;
    }
  });

  it('uses the official bundled Hermes CLI when it exists', async () => {
    const previousHome = process.env.HERMES_HOME;
    const previousCli = process.env.HERMES_CLI;
    const hermesHome = path.join(tmpDir, 'hermes-profile');
    const bundledCli = path.join(
      hermesHome,
      'hermes-agent',
      'venv',
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'hermes.exe' : 'hermes',
    );
    process.env.HERMES_HOME = hermesHome;
    delete process.env.HERMES_CLI;
    try {
      await fs.mkdir(path.dirname(bundledCli), { recursive: true });
      await fs.writeFile(bundledCli, '');
      const def = {
        id: 'hermes-agent',
        displayName: 'Hermes Agent',
        deployMode: 'directory-plugin',
        detection: { paths: ['$HERMES_HOME'], commands: ['hermes'] },
        directoryPlugin: {
          sourceDir: '$PILOT_DIR/hermes-plugin',
          targetDir: '$HERMES_HOME/plugins/loongsuite-pilot',
          activation: {
            command: '$HERMES_CLI',
            enableArgs: ['plugins', 'enable', 'loongsuite-pilot'],
          },
        },
      };
      await fs.writeFile(path.join(builtinDir, 'hermes-agent.json'), JSON.stringify(def));

      const [loaded] = await makeLoader().load();

      expect(loaded.directoryPlugin?.activation?.command).toBe(bundledCli);
    } finally {
      if (previousHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = previousHome;
      if (previousCli === undefined) delete process.env.HERMES_CLI;
      else process.env.HERMES_CLI = previousCli;
    }
  });

  it('handles missing directories gracefully', async () => {
    const loader = new AgentDefLoader({
      builtinDir: path.join(tmpDir, 'nonexistent'),
      localDir: path.join(tmpDir, 'also-nonexistent'),
      pilotDir: '/opt/pilot',
      dataDir: '/home/user/.loongsuite-pilot',
    });

    const defs = await loader.load();
    expect(defs).toHaveLength(0);
  });

});
