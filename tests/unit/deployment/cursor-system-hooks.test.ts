import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import type { AgentDefinition } from '../../../src/types/deployment.js';
import { systemHookDefinition } from '../../../src/deployment/system-hook-config.js';
import { cursorSystemHooksInstalled, updateCursorSystemHooks } from '../../../src/deployment/cursor-system-hooks.js';
import { areSystemHookAssetsHealthy } from '../../../src/deployment/system-hook-assets.js';
import { runHookInstall } from '../../../src/deployment/hook-install-service.js';
import { DeploymentManager } from '../../../src/deployment/deployment-manager.js';
import { isolateAgentHome } from '../../helpers/isolated-agent-home.js';

vi.mock('node:os', async original => {
  const actual = await original<typeof import('node:os')>();
  const homedir = vi.fn(actual.homedir);
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

let root: string;
let dataDir: string;
let def: AgentDefinition;
let restore: () => void;
let runtimeRoot: string;
let trustedNode: string;
let pilotDir: string;
beforeAll(async () => {
  runtimeRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'cursor-system-runtime-'));
  trustedNode = path.join(runtimeRoot, path.basename(process.execPath));
  pilotDir = path.join(runtimeRoot, 'pilot');
  await fs.mkdir(path.join(pilotDir, 'assets'), { recursive: true });
  // Model an installed, trusted runtime even when CI uses a shared checkout.
  await Promise.all([
    fs.copyFile(process.execPath, trustedNode, fs.constants.COPYFILE_FICLONE),
    fs.cp(path.resolve('assets/hooks'), path.join(pilotDir, 'assets/hooks'), { recursive: true }),
    fs.cp(path.resolve('agents.d'), path.join(pilotDir, 'agents.d'), { recursive: true }),
  ]);
  await fs.chmod(trustedNode, 0o700);
});
afterAll(async () => { await fs.rm(runtimeRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-system-'));
  const restoreHome = isolateAgentHome(root);
  const previousConfig = process.env.AGENT_DATA_COLLECTION_CONFIG;
  dataDir = path.join(root, "pilot's data");
  process.env.AGENT_DATA_COLLECTION_CONFIG = path.join(dataDir, 'config.json');
  restore = () => {
    restoreHome();
    if (previousConfig === undefined) delete process.env.AGENT_DATA_COLLECTION_CONFIG;
    else process.env.AGENT_DATA_COLLECTION_CONFIG = previousConfig;
  };
  await fs.mkdir(dataDir);
  await fs.writeFile(path.join(dataDir, 'node-bin'), trustedNode + '\n', { mode: 0o644 });
  def = { id: 'cursor', displayName: 'Cursor', deployMode: 'hook',
    detection: { paths: [path.join(root, 'user/.cursor')], commands: [] },
    hook: { settingsPath: path.join(root, 'user/.cursor/hooks.json'),
      systemSettingsPath: path.join(root, 'etc/cursor/hooks.json'),
      hookCommand: path.join(dataDir, 'hooks/cursor-loongsuite-pilot-hook.sh'),
      events: ['beforeSubmitPrompt', 'postToolUse', 'stop'], format: 'flat' } };
});
afterEach(async () => { restore(); await fs.rm(root, { recursive: true, force: true }); });
async function write(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

describe('Cursor enterprise system registration', () => {
  it('writes versioned flat hooks and preserves customer configuration during upgrade and removal', async () => {
    const target = systemHookDefinition(def);
    const customer = { version: 1, hooks: { stop: [{ command: 'customer-audit', timeout: 2 }], workspaceOpen: [] } };
    await write(target.hook!.settingsPath, JSON.stringify(customer));
    await updateCursorSystemHooks(target, true);
    const once = await fs.readFile(target.hook!.settingsPath, 'utf8');
    const value = JSON.parse(once);
    expect(value.version).toBe(1);
    expect(value.hooks.stop[0]).toEqual(customer.hooks.stop[0]);
    expect(value.hooks.stop[1]).toMatchObject({ failClosed: false });
    expect(value.hooks.stop[1]).not.toHaveProperty('hooks');
    expect(await cursorSystemHooksInstalled(target)).toBe(true);
    await updateCursorSystemHooks(target, true);
    expect(await fs.readFile(target.hook!.settingsPath, 'utf8')).toBe(once);
    await updateCursorSystemHooks(target, false);
    expect(JSON.parse(await fs.readFile(target.hook!.settingsPath, 'utf8'))).toEqual(customer);
  });

  it('initializes a missing version and refuses an incompatible version unchanged', async () => {
    const target = systemHookDefinition(def);
    await updateCursorSystemHooks(target, true);
    expect(JSON.parse(await fs.readFile(target.hook!.settingsPath, 'utf8')).version).toBe(1);
    for (const version of [0, 2, '1']) {
      const text = JSON.stringify({ version, hooks: {} });
      await write(target.hook!.settingsPath, text);
      await expect(updateCursorSystemHooks(target, true)).rejects.toThrow('version 1');
      expect(await fs.readFile(target.hook!.settingsPath, 'utf8')).toBe(text);
    }
  });

  it('refuses malformed, conflicting, read-only, and symlinked policies without a write', async () => {
    const target = systemHookDefinition(def);
    const file = target.hook!.settingsPath;
    for (const policy of [
      '{"version":1,"hooks":',
      '{"version":1,"hooks":{},"hooks":{}}',
      '{"version":1,"hooks":{"stop":{}}}',
      '{"version":1,"hooks":{"stop":[{"command":"/somewhere/else/cursor-loongsuite-pilot-hook.sh"}]}}',
    ]) {
      await write(file, policy);
      await expect(updateCursorSystemHooks(target, true)).rejects.toThrow('original preserved');
      expect(await fs.readFile(file, 'utf8')).toBe(policy);
    }
    const policy = '{"version":1,"hooks":{}}';
    await write(file, policy);
    await fs.chmod(file, 0o444);
    await expect(updateCursorSystemHooks(target, true)).rejects.toThrow('read-only');
    expect(await fs.readFile(file, 'utf8')).toBe(policy);
    await fs.rename(file, file + '.original');
    await fs.symlink(file + '.original', file);
    await expect(updateCursorSystemHooks(target, true)).rejects.toThrow('regular file');
    expect(await fs.readlink(file)).toBe(file + '.original');
    expect(await fs.readFile(file, 'utf8')).toBe(policy);
  });

  it.runIf(process.platform !== 'win32')('rejects a policy or managed directory writable by other users', async () => {
    const target = systemHookDefinition(def);
    const file = target.hook!.settingsPath;
    await updateCursorSystemHooks(target, true);
    const installed = await fs.readFile(file, 'utf8');
    await fs.chmod(file, 0o666);
    await expect(cursorSystemHooksInstalled(target)).rejects.toThrow('untrusted owner or mode');
    await expect(updateCursorSystemHooks(target, false)).rejects.toThrow('untrusted owner or mode');
    expect(await fs.readFile(file, 'utf8')).toBe(installed);

    await fs.chmod(file, 0o644);
    await fs.chmod(path.dirname(file), 0o777);
    await expect(cursorSystemHooksInstalled(target)).rejects.toThrow('Untrusted Cursor system directory permissions');
    await expect(updateCursorSystemHooks(target, true)).rejects.toThrow('Untrusted Cursor system directory permissions');
    expect(await fs.readFile(file, 'utf8')).toBe(installed);
  });

  const separateGroup = process.getgroups?.().find(group => group !== process.getegid?.());
  it.runIf(separateGroup !== undefined)('retains the managed file owner, group and mode on rewrite', async () => {
    const target = systemHookDefinition(def);
    const file = target.hook!.settingsPath;
    await write(file, '{"version":1,"hooks":{}}');
    const uid = process.geteuid!();
    await fs.chown(file, uid, separateGroup!);
    await fs.chmod(file, 0o640);
    await updateCursorSystemHooks(target, true);
    const stat = await fs.stat(file);
    expect(stat.uid).toBe(uid);
    expect(stat.gid).toBe(separateGroup);
    expect(stat.mode & 0o777).toBe(0o640);
  });

  it('does not mistake an unrelated agent command or an IDE home for the CLI', async () => {
    const builtin = path.join(root, 'agents.d');
    const bin = path.join(root, 'bin');
    const agent = path.join(bin, 'agent');
    await write(path.join(builtin, 'cursor.json'), JSON.stringify(def));
    await write(path.join(builtin, 'cursor-cli.json'), JSON.stringify({ ...def, id: 'cursor-cli',
      detection: { paths: [], commands: ['cursor-agent'] }, hook: { ...def.hook, events: [], hookCommand: '' } }));
    await fs.mkdir(path.dirname(def.hook!.settingsPath), { recursive: true });
    await write(agent, '#!/bin/sh\nexit 99\n');
    await fs.chmod(agent, 0o755);
    vi.stubEnv('PATH', bin + path.delimiter + '/usr/bin:/bin');
    try {
      const opts = { dataDir, pilotDir, builtinAgentsDir: builtin, deploymentScope: 'system' as const };
      const ide = await runHookInstall(opts);
      expect(ide.report.agents[0]).toMatchObject({ id: 'cursor', settingsPath: def.hook!.settingsPath });
      expect(ide.report.agents[0]).not.toHaveProperty('hookScope');
      await expect(fs.stat(def.hook!.systemSettingsPath!)).rejects.toMatchObject({ code: 'ENOENT' });

      const vendor = path.join(root, 'vendor', 'cursor-agent');
      await fs.mkdir(path.dirname(vendor));
      await fs.rename(agent, vendor);
      await fs.symlink(vendor, agent);
      const cli = await runHookInstall(opts);
      expect(cli.exitCode).toBe(0);
      expect(cli.report.agents).toHaveLength(1);
      expect(cli.report.agents[0]).toMatchObject({ id: 'cursor', hookScope: 'system' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  for (const agentsFlag of [undefined, 'cursor-cli', 'cursor,cursor-cli']) {
    it(`registers one shared target when only the CLI is detected (${agentsFlag ?? 'automatic'})`, async () => {
      const builtin = path.join(root, 'agents.d');
      await write(path.join(builtin, 'cursor.json'), JSON.stringify(def));
      const cli = { id: 'cursor-cli', displayName: 'Cursor CLI', deployMode: 'hook',
        detection: { paths: [path.join(root, 'cli-installed')], commands: [] },
        hook: { ...def.hook, systemSettingsPath: undefined, hookCommand: '', events: [] } };
      await write(path.join(builtin, 'cursor-cli.json'), JSON.stringify(cli));
      await fs.mkdir(path.join(root, 'cli-installed'));
      const opts = { dataDir, pilotDir, builtinAgentsDir: builtin, agentsFlag };
      const result = await runHookInstall({ ...opts, deploymentScope: 'system' });
      expect(result.exitCode).toBe(0);
      expect((await fs.stat(path.join(dataDir, 'logs/cursor/history'))).isDirectory()).toBe(true);
      expect(result.report.agents).toHaveLength(1);
      expect(result.report.agents[0]).toMatchObject({ id: 'cursor', hookScope: 'system', runtimeHealthy: true, collectionStatus: 'not-verified' });
      expect(result.report.agents[0].hint).toContain('Enterprise');
      const state = JSON.parse(await fs.readFile(path.join(dataDir, 'deployed-agents.json'), 'utf8'));
      expect(Object.keys(state)).toEqual(['cursor']);
      expect(await fs.stat(def.hook!.settingsPath).catch(() => null)).toBeNull();
      const status = await runHookInstall({ ...opts, mode: 'status' });
      expect(status.report.agents).toHaveLength(1);
      expect(status.report.agents[0].hookScope).toBe('system');
      const manager = new DeploymentManager(opts);
      const [loaded] = (await manager.loadDefinitions()).filter(item => item.id === 'cursor');
      await fs.unlink(path.join(dataDir, 'hooks/cursor/source-event.mjs'));
      expect(await manager.needsRedeploy(loaded)).toBe(true);
      expect((await manager.repairHookSettings(loaded)).success).toBe(true);
      expect(await manager.needsRedeploy(loaded)).toBe(false);
      expect(await manager.undeployAgent(loaded)).toBe(true);
      expect(JSON.parse(await fs.readFile(def.hook!.systemSettingsPath!, 'utf8'))).toEqual({ version: 1, hooks: {} });
    });
  }

  it('uses the running eager Node to install on the first attempt without a prior pin', async () => {
    const builtinAgentsDir = path.join(root, 'agents.d');
    const cliHome = path.join(root, 'cli-only');
    await fs.mkdir(cliHome);
    await write(path.join(builtinAgentsDir, 'cursor.json'), JSON.stringify(def));
    await write(path.join(builtinAgentsDir, 'cursor-cli.json'), JSON.stringify({
      ...def, id: 'cursor-cli', detection: { paths: [cliHome], commands: [] },
      hook: { ...def.hook, events: [], hookCommand: '' },
    }));
    const pin = path.join(dataDir, 'node-bin');
    await fs.unlink(pin);
    const opts = { dataDir, pilotDir, builtinAgentsDir, agentsFlag: 'cursor-cli',
      deploymentScope: 'system' as const, writeResult: false };
    const noRuntime = await runHookInstall(opts);
    expect(noRuntime.exitCode).toBe(1);
    await expect(fs.lstat(pin)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(def.hook!.systemSettingsPath!)).rejects.toMatchObject({ code: 'ENOENT' });

    const installed = await runHookInstall({ ...opts, eagerCursorNodePath: trustedNode });
    expect(installed.exitCode).toBe(0);
    expect(installed.report.agents[0]).toMatchObject({ id: 'cursor', hookScope: 'system', runtimeHealthy: true });
    const pinned = (await fs.realpath(trustedNode)) + '\n';
    expect(await fs.readFile(pin, 'utf8')).toBe(pinned);
    expect(await cursorSystemHooksInstalled(systemHookDefinition(def))).toBe(true);
    await expect(fs.lstat(def.hook!.settingsPath)).rejects.toMatchObject({ code: 'ENOENT' });

    // A later eager child must not replace an existing pin.
    const again = await runHookInstall({ ...opts, eagerCursorNodePath: path.join(root, 'other-node') });
    expect(again.exitCode).toBe(0);
    expect(await fs.readFile(pin, 'utf8')).toBe(pinned);
  });

  it('retains default home behavior and supports migrating the CLI alias back to home', async () => {
    const builtin = path.join(root, 'agents.d');
    await write(path.join(builtin, 'cursor.json'), JSON.stringify(def));
    await write(path.join(builtin, 'cursor-cli.json'), JSON.stringify({ ...def, id: 'cursor-cli', hook: { ...def.hook, events: [], hookCommand: '' } }));
    await fs.mkdir(path.join(root, 'user/.cursor'), { recursive: true });
    const opts = { dataDir, pilotDir, builtinAgentsDir: builtin };
    expect((await runHookInstall({ ...opts, agentsFlag: 'cursor' })).exitCode).toBe(0);
    expect(await fs.stat(def.hook!.systemSettingsPath!).catch(() => null)).toBeNull();
    expect((await runHookInstall({ ...opts, agentsFlag: 'cursor-cli', deploymentScope: 'system' })).exitCode).toBe(0);
    expect(await fs.readFile(def.hook!.settingsPath, 'utf8')).not.toContain('cursor-loongsuite-pilot-hook');
    expect((await runHookInstall({ ...opts, agentsFlag: 'cursor-cli', deploymentScope: 'user' })).exitCode).toBe(0);
    expect(await fs.readFile(def.hook!.systemSettingsPath!, 'utf8')).not.toContain('cursor-loongsuite-pilot-hook');
    expect(await fs.readFile(def.hook!.settingsPath, 'utf8')).toContain('cursor-loongsuite-pilot-hook');
  });

  it('does not bypass a disabled CLI alias or the canonical Cursor admission gate', async () => {
    const builtin = path.join(root, 'agents.d');
    await write(path.join(builtin, 'cursor.json'), JSON.stringify(def));
    const cliHome = path.join(root, 'cli-only');
    await fs.mkdir(cliHome);
    await write(path.join(builtin, 'cursor-cli.json'), JSON.stringify({ ...def, id: 'cursor-cli',
      detection: { paths: [cliHome], commands: [] }, hook: { ...def.hook, events: [], hookCommand: '' } }));
    const opts = { dataDir, pilotDir, builtinAgentsDir: builtin, agentsFlag: 'cursor-cli', deploymentScope: 'system' as const };
    const cliDisabled = await runHookInstall({ ...opts, enabled: id => id !== 'cursor-cli' });
    expect(cliDisabled.report.agents[0]).toMatchObject({ id: 'cursor-cli', reason: 'disabled' });
    const cursorDisabled = await runHookInstall({ ...opts, enabled: id => id !== 'cursor' });
    expect(cursorDisabled.report.agents[0]).toMatchObject({ id: 'cursor', reason: 'disabled' });
    const autoDisabled = await runHookInstall({ ...opts, agentsFlag: undefined, enabled: id => id !== 'cursor-cli' });
    expect(autoDisabled.report.agents).toEqual([]);
    expect(await fs.stat(def.hook!.systemSettingsPath!).catch(() => null)).toBeNull();
  });

  it('refuses to register a local Cursor command outside the managed runtime', async () => {
    const builtinAgentsDir = path.join(root, 'agents.d');
    await write(path.join(builtinAgentsDir, 'cursor.json'), JSON.stringify(def));
    const manager = new DeploymentManager({ dataDir, pilotDir, builtinAgentsDir });
    const target = systemHookDefinition(def);
    const customer = { version: 1, hooks: { stop: [{ command: 'customer-audit' }] } };
    await write(target.hook!.settingsPath, JSON.stringify(customer));
    expect((await manager.deployHookScope(target)).success).toBe(true);
    const original = await fs.readFile(target.hook!.settingsPath, 'utf8');
    const state = path.join(dataDir, 'deployed-agents.json');
    const originalState = await fs.readFile(state, 'utf8');

    const overriddenCommand = path.join(root, 'elsewhere/cursor-loongsuite-pilot-hook.sh');
    await write(overriddenCommand, '#!/bin/bash\n');
    await write(path.join(dataDir, 'agents.d.local/cursor.json'), JSON.stringify({
      ...def, hook: { ...def.hook, hookCommand: overriddenCommand },
    }));
    const [overridden] = await manager.loadDefinitions();
    expect(overridden.hook!.hookCommand).toBe(overriddenCommand);
    await expect(manager.deployHookScope(systemHookDefinition(overridden))).rejects.toThrow('managed Pilot wrapper');
    expect(await fs.readFile(target.hook!.settingsPath, 'utf8')).toBe(original);
    expect(await fs.readFile(state, 'utf8')).toBe(originalState);
    expect(await manager.undeployAgent(overridden)).toBe(true);
    expect(JSON.parse(await fs.readFile(target.hook!.settingsPath, 'utf8'))).toEqual(customer);
  });

  it('writes independent identities to the common journal without inherited Pilot variables', async () => {
    const homes = ['a', 'b', 'created-after-install'].map(identity => path.join(root, identity));
    await Promise.all(homes.slice(0, 2).map(home => fs.mkdir(home)));
    const manager = new DeploymentManager({ dataDir, pilotDir });
    const target = systemHookDefinition(def);
    const journalDir = path.join(dataDir, 'state/cursor');
    await fs.mkdir(journalDir, { recursive: true, mode: 0o755 });
    expect((await manager.deployHookScope(target)).success).toBe(true);
    expect((await fs.stat(journalDir)).mode & 0o777).toBe(0o700);
    const { hooks } = JSON.parse(await fs.readFile(target.hook!.settingsPath, 'utf8'));
    const command = hooks.beforeSubmitPrompt[0].command;
    await fs.mkdir(homes[2]);
    const journalFile = path.join(journalDir, 'event-journal.jsonl');
    for (const home of homes) {
      const identity = path.basename(home);
      const env = { ...process.env, HOME: home, PATH: '/usr/bin:/bin' };
      delete env.LOONGSUITE_PILOT_DATA_DIR;
      delete env.PILOT_DATA;
      const result = spawnSync('/bin/bash', ['-c', command], { env, encoding: 'utf8', timeout: 10000,
        input: JSON.stringify({ hook_event_name: 'beforeSubmitPrompt', conversation_id: identity, generation_id: identity,
          cursor_version: '2026.11.10', prompt: 'test', workspace_roots: [home] }) });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({});
      expect(await fs.stat(path.join(home, '.loongsuite-pilot')).catch(() => null)).toBeNull();
      expect((await fs.stat(journalDir)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(journalFile)).mode & 0o777).toBe(0o600);
      if (identity === 'a') {
        // Simulate an older owned journal before the next HOME starts.
        await fs.chmod(journalFile, 0o644);
        await fs.chmod(journalDir, 0o755);
      }
    }
    const cleanEnv = { PATH: '/usr/bin:/bin' };
    const noHome = spawnSync('/bin/bash', ['-c', command], { input: JSON.stringify({
      hook_event_name: 'beforeSubmitPrompt', conversation_id: 'no-home', generation_id: 'no-home',
      cursor_version: '2026.11.10', prompt: 'test',
    }), env: cleanEnv, encoding: 'utf8', timeout: 10000 });
    expect(noHome.status, noHome.stderr).toBe(0);
    expect(JSON.parse(noHome.stdout)).toEqual({});
    const journal = (await fs.readFile(journalFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(journal.map(event => event.conversation_id)).toEqual(['a', 'b', 'created-after-install', 'no-home']);
    await fs.unlink(path.join(dataDir, 'hooks/cursor/source-event.mjs'));
    const missing = spawnSync('/bin/bash', ['-c', command], { input: '{}', env: cleanEnv, encoding: 'utf8', timeout: 10000 });
    expect(missing.status, missing.stderr).toBe(0);
    expect(JSON.parse(missing.stdout)).toEqual({});
  });

  it.each([true, false])('recovers a native headless turn with system capture set to %s', async (capture) => {
    const target = systemHookDefinition({
      ...def, hook: { ...def.hook!, events: [...def.hook!.events, 'sessionEnd'] },
    });
    const manager = new DeploymentManager({ dataDir, pilotDir });
    const collectorPolicy = path.join(root, 'collector policy', 'policy.json');
    const stalePolicy = path.join(dataDir, 'config.json');
    await write(collectorPolicy, JSON.stringify({
      agents: { 'cursor-cli': { captureMessageContent: capture } },
    }));
    await write(stalePolicy, JSON.stringify({
      agents: { 'cursor-cli': { captureMessageContent: !capture } },
    }));
    process.env.AGENT_DATA_COLLECTION_CONFIG = collectorPolicy;
    expect((await manager.deployHookScope(target)).success).toBe(true);

    const home = path.join(root, 'identity-created-after-install');
    const session = 'headless-session';
    const transcript = path.join(home, '.cursor/projects/workspace/agent-transcripts', session, session + '.jsonl');
    await write(transcript, [
      { role: 'user', message: { content: [{ type: 'text', text: 'native user prompt' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'native assistant reply' }] } },
      { type: 'turn_ended', status: 'success' },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');

    const { hooks } = JSON.parse(await fs.readFile(target.hook!.settingsPath, 'utf8'));
    const sendEnd = (id: string, transcriptPath: string) => spawnSync('/bin/bash', ['-c', hooks.sessionEnd[0].command], {
      env: { HOME: home, PATH: '/usr/bin:/bin', AGENT_DATA_COLLECTION_CONFIG: stalePolicy },
      encoding: 'utf8', timeout: 10_000,
      input: JSON.stringify({
        hook_event_name: 'sessionEnd', session_id: id, conversation_id: id, generation_id: id,
        cursor_version: '2026.09.26-dd393fe', reason: 'completed', duration_ms: 100,
        transcript_path: transcriptPath, workspace_roots: [home],
      }),
    });
    const result = sendEnd(session, transcript);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
    const history = path.join(dataDir, 'logs/cursor/history');
    const files = (await fs.readdir(history)).filter(file => file.endsWith('.jsonl'));
    expect(files).toHaveLength(1);
    const output = await fs.readFile(path.join(history, files[0]), 'utf8');
    expect(output).toContain('llm.response');
    expect(output.includes('native user prompt')).toBe(capture);
    expect(output.includes('native assistant reply')).toBe(capture);
    const journal = path.join(dataDir, 'state/cursor/event-journal.jsonl');
    const prompt = 'system policy privacy regression marker';
    const sendPrompt = (identity: string) => spawnSync('/bin/bash', ['-c', hooks.beforeSubmitPrompt[0].command], {
      env: { HOME: home, PATH: '/usr/bin:/bin', AGENT_DATA_COLLECTION_CONFIG: stalePolicy, LOONGSUITE_CURSOR_RAW_TRACE: '1' },
      encoding: 'utf8', timeout: 10_000,
      input: JSON.stringify({
        hook_event_name: 'beforeSubmitPrompt', conversation_id: identity, generation_id: identity,
        cursor_version: '2026.09.26-dd393fe', prompt,
      }),
    });
    expect(sendPrompt('explicit-policy').status).toBe(0);
    expect((await fs.readFile(journal, 'utf8')).includes(prompt)).toBe(capture);
    const raw = path.join(dataDir, 'logs/cursor/raw/cursor-raw-trace.jsonl');
    expect((await fs.readFile(raw, 'utf8').catch(() => '')).includes(prompt)).toBe(capture);

    if (process.geteuid?.() !== 0) {
      const id = 'completed-while-policy-unreadable';
      const deferred = path.join(path.dirname(path.dirname(transcript)), id, id + '.jsonl');
      await write(deferred, (await fs.readFile(transcript, 'utf8')).replace('native user prompt', 'deferred native prompt'));
      await fs.chmod(collectorPolicy, 0o000);
      const blocked = sendEnd(id, deferred);
      expect(blocked.status, blocked.stderr).toBe(0);
      expect(await fs.readFile(journal, 'utf8')).toContain('"session_id":"' + id + '"');
      await fs.chmod(collectorPolicy, 0o600);
      expect(sendPrompt('wake-recovery').status).toBe(0);
      const recovered = (await fs.readFile(path.join(history, files[0]), 'utf8'))
        .trim().split('\n').map(row => JSON.parse(row)).filter(row => row['gen_ai.session.id'] === id);
      expect(recovered).toHaveLength(3);
      expect(JSON.stringify(recovered)).not.toContain('deferred native prompt');
    }

    await fs.unlink(collectorPolicy);
    expect(sendPrompt('missing-policy').status).toBe(0);
    const latest = JSON.parse((await fs.readFile(journal, 'utf8')).trim().split('\n').at(-1)!);
    expect(latest).toMatchObject({ conversation_id: 'missing-policy', content_omitted: true });
    expect(latest).not.toHaveProperty('prompt');
    await expect(fs.stat(path.join(home, '.loongsuite-pilot'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.runIf(process.platform === 'linux')('accepts the packaged hooks alias without relaxing permissions', async () => {
    await fs.chmod(dataDir, 0o755);
    await fs.cp(path.join(pilotDir, 'assets/hooks'), path.join(dataDir, 'hooks'), { recursive: true });
    const alias = path.join(dataDir, 'assets/hooks');
    await fs.mkdir(path.dirname(alias), { mode: 0o755 });
    await fs.symlink('../hooks', alias);

    const target = systemHookDefinition(def);
    const manager = new DeploymentManager({ dataDir, pilotDir: dataDir });
    const settings = target.hook!.settingsPath;
    expect((await manager.deployHookScope(target)).success).toBe(true);
    expect(await areSystemHookAssetsHealthy('cursor', dataDir, dataDir)).toBe(true);
    const registered = await fs.readFile(settings, 'utf8');

    await fs.chmod(dataDir, 0o777);
    await expect(manager.deployHookScope(target)).rejects.toThrow('Untrusted Cursor system directory permissions');
    await fs.chmod(dataDir, 0o755);

    await fs.unlink(alias);
    await fs.symlink(path.join(pilotDir, 'assets/hooks'), alias);
    await expect(manager.deployHookScope(target)).rejects.toThrow('Untrusted Cursor system directory permissions');
    expect(await fs.readFile(settings, 'utf8')).toBe(registered);
  });

  it('refuses an untrusted installed asset, Node pin or executable without using the caller fallback', async () => {
    const target = systemHookDefinition(def);
    const manager = new DeploymentManager({ dataDir, pilotDir });
    expect((await manager.deployHookScope(target)).success).toBe(true);
    const { hooks } = JSON.parse(await fs.readFile(target.hook!.settingsPath, 'utf8'));
    const command = hooks.beforeSubmitPrompt[0].command;
    const pin = path.join(dataDir, 'node-bin');
    const processor = path.join(dataDir, 'hooks/cursor-hook-processor.mjs');
    const journal = path.join(dataDir, 'state/cursor/event-journal.jsonl');
    const home = path.join(root, 'agent-home');
    const fallback = path.join(home, '.local/bin/node');
    await write(fallback, '#!/bin/sh\nprintf used > "$CURSOR_TEST_NODE_USED"\nexit 0\n');
    await fs.chmod(fallback, 0o755);
    const usedFallback = path.join(root, 'fallback-used');
    const run = () => spawnSync('/bin/bash', ['-c', command], {
      env: { ...process.env, HOME: home, PATH: path.dirname(fallback) + ':/usr/bin:/bin',
        CURSOR_TEST_NODE_USED: usedFallback },
      input: JSON.stringify({ hook_event_name: 'beforeSubmitPrompt', conversation_id: 'system-test',
        generation_id: 'test', cursor_version: '2026.11.10', prompt: 'synthetic' }),
      encoding: 'utf8', timeout: 10_000,
    });
    const expectFailOpen = async () => {
      expect(await areSystemHookAssetsHealthy('cursor', pilotDir, dataDir)).toBe(false);
      const result = run();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({});
      expect(result.stderr).toContain('untrusted');
      await expect(fs.stat(journal)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(usedFallback)).rejects.toMatchObject({ code: 'ENOENT' });
    };
    await fs.chmod(dataDir, 0o777);
    await expectFailOpen();
    await expect(manager.deployHookScope(target)).rejects.toThrow('Untrusted Cursor system directory permissions');
    await fs.chmod(dataDir, 0o755);
    await fs.chmod(processor, 0o666);
    await expectFailOpen();
    expect((await manager.repairHookSettings(def)).success).toBe(true);
    expect((await fs.stat(processor)).mode & 0o777).toBe(0o644);
    await fs.chmod(pin, 0o666);
    await expectFailOpen();
    await fs.chmod(pin, 0o644);
    const configPin = path.join(dataDir, 'hooks/cursor-system-config-path');
    await fs.chmod(configPin, 0o666);
    await expectFailOpen();
    expect((await manager.repairHookSettings(def)).success).toBe(true);
    expect((await fs.stat(configPin)).mode & 0o777).toBe(0o644);
    const config = path.join(dataDir, 'config.json');
    await write(config, '{}\n');
    await fs.chmod(config, 0o666);
    await expectFailOpen();
    await fs.unlink(config);
    const binary = path.join(root, 'untrusted-runtime', 'node');
    await write(binary, '#!/bin/sh\nprintf used > "$CURSOR_TEST_NODE_USED"\nexit 0\n');
    await fs.chmod(binary, 0o755);
    await fs.chmod(path.dirname(binary), 0o777);
    await fs.writeFile(pin, binary + '\n');
    await expectFailOpen();
    await fs.unlink(pin);
    await expectFailOpen();
  });
});
