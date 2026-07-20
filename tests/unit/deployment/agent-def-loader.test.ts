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

  it('loads activityIndicator and expands ~', async () => {
    const def = {
      id: 'ai-test',
      displayName: 'AI Test',
      deployMode: 'hook',
      detection: { paths: ['~/.claude'], commands: [] },
      activityIndicator: '~/.claude/history.jsonl',
    };
    await fs.writeFile(path.join(builtinDir, 'ai.json'), JSON.stringify(def));

    const defs = await makeLoader().load();

    expect(defs[0].activityIndicator).toBe(path.join(os.homedir(), '.claude/history.jsonl'));
  });

  it('loads versionSource of type jsonFile with ~ expansion', async () => {
    const def = {
      id: 'vs-file-test',
      displayName: 'VS File Test',
      deployMode: 'hook',
      detection: { paths: ['~/.codex'], commands: [] },
      versionSource: { type: 'jsonFile', file: '~/.codex/version.json', key: 'latest_version' },
    };
    await fs.writeFile(path.join(builtinDir, 'vsfile.json'), JSON.stringify(def));

    const defs = await makeLoader().load();
    const vs = defs[0].versionSource;

    expect(vs).toBeDefined();
    expect(vs && 'type' in vs ? vs.type : undefined).toBe('jsonFile');
    expect(vs && vs.type === 'jsonFile' ? vs.file : undefined).toBe(
      path.join(os.homedir(), '.codex/version.json'),
    );
    expect(vs && vs.type === 'jsonFile' ? vs.key : undefined).toBe('latest_version');
  });

  it('loads versionSource of type command unchanged', async () => {
    const def = {
      id: 'vs-cmd-test',
      displayName: 'VS Cmd Test',
      deployMode: 'plugin-inject',
      detection: { paths: ['~/.config/opencode'], commands: [] },
      versionSource: { type: 'command', command: 'opencode --version' },
    };
    await fs.writeFile(path.join(builtinDir, 'vscmd.json'), JSON.stringify(def));

    const defs = await makeLoader().load();
    const vs = defs[0].versionSource;

    expect(vs && vs.type === 'command' ? vs.command : undefined).toBe('opencode --version');
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
