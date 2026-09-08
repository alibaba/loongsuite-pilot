import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveOpenClawHost } from '../../../src/deployment/openclaw-version-resolver.js';
import { PluginInjectStrategy } from '../../../src/deployment/plugin-inject-strategy.js';
import type { AgentDefinition } from '../../../src/types/index.js';

// Execute only the actual config writer, never the installer/service commands.
// PowerShell's embedded JS is executed on every platform; native PS startup is
// a separate Windows acceptance gate, not claimed by these tests.
describe.each(['shell', 'powershell'])('%s OpenClaw installation state', platform => {
  let root: string;
  let dataDir: string;
  let configPath: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-oc-install-'));
    dataDir = path.join(root, 'custom pilot data');
    await fs.mkdir(dataDir);
    configPath = path.join(dataDir, 'config.json');
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  async function writeConfig(probe: unknown[], selected = 'openclaw,codex', explicit = false) {
    const file = platform === 'shell' ? 'deploy/installer-opensource.sh' : 'deploy/installer-opensource.ps1';
    const installer = await fs.readFile(file, 'utf8');
    const cleanEnv = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, SystemRoot: process.env.SystemRoot, TEMP: root };
    if (platform === 'shell') {
      const start = installer.indexOf('write_config() {');
      const end = installer.indexOf('\n# ============================================================', start);
      const fn = installer.slice(start, end);
      execFileSync('bash', ['-c', `set -eo pipefail\nmsg() { :; }\n${fn}\nwrite_config`], {
        env: { ...cleanEnv, DATA_DIR: dataDir, NODE_BIN: process.execPath,
          PROBE_RESULT: JSON.stringify(probe), SELECTED_AGENTS: selected, AGENT_SELECTION_EXPLICIT: explicit ? '1' : '0' },
        timeout: 10000,
      });
    } else {
      const start = installer.indexOf("const fs = require('fs');\nlet raw = fs.readFileSync(process.argv[1]");
      const end = installer.indexOf("\n'@ $cfgTmp", start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const opts = path.join(root, 'opts.json');
      await fs.writeFile(opts, JSON.stringify({ configPath, dataDir, selectedAgents: selected,
        probeResult: JSON.stringify(probe), agentSelectionExplicit: explicit ? '1' : '0' }));
      execFileSync(process.execPath, ['-e', installer.slice(start, end), opts], { env: cleanEnv, timeout: 10000 });
    }
    return JSON.parse(await fs.readFile(configPath, 'utf8'));
  }
  const probe = (detected: boolean, entry?: string) => [
    { id: 'openclaw', detected, ...(entry ? { openclawCliPath: entry } : {}) },
    { id: 'codex', detected: true },
  ];

  it.each(['2026.3.8', '2026.6.10'])('auto discovery -> install -> fresh service env -> idempotent injection (%s)', async version => {
    const app = path.join(root, 'app');
    await fs.mkdir(app);
    const entry = path.join(app, 'openclaw.mjs');
    await fs.writeFile(entry, '/* never executed */');
    await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'openclaw', version }));
    const discovered = await resolveOpenClawHost({}, app);
    expect(discovered?.binding).toBe('auto-entry');
    const installed = await writeConfig(probe(true, discovered!.executable));
    expect(installed.agents.openclaw).toEqual({ enabled: true, cliPath: entry });
    const env = { AGENT_DATA_COLLECTION_CONFIG: configPath, PATH: '' };
    const resolved = await resolveOpenClawHost(env, dataDir);
    expect(resolved).toMatchObject({ version, executable: entry, binding: 'persisted-entry' });
    const gatewayConfig = path.join(root, 'gateway.json');
    const def: AgentDefinition = { id: 'openclaw', displayName: 'OpenClaw', deployMode: 'plugin-inject',
      detection: { paths: [], commands: [] }, pluginInject: { configPaths: [gatewayConfig],
        configShape: 'openclaw-nested', createIfMissing: true, pluginId: 'loongsuite-pilot-openclaw',
        pluginSpec: 'file://$PILOT_DATA/plugins/openclaw' } };
    const strategy = new PluginInjectStrategy(dataDir, root, () => resolveOpenClawHost(env, dataDir));
    expect((await strategy.deploy(def)).success).toBe(true);
    const before = await fs.readFile(gatewayConfig, 'utf8');
    const mtime = (await fs.stat(gatewayConfig)).mtimeMs;
    expect(JSON.parse(before).plugins.entries['loongsuite-pilot-openclaw'].hooks?.allowConversationAccess)
      .toBe(version === '2026.3.8' ? undefined : true);
    await writeConfig(probe(true, discovered!.executable));
    expect(await strategy.needsDeploy(def)).toBe(false);
    expect((await strategy.deploy(def)).success).toBe(true);
    expect(await fs.readFile(gatewayConfig, 'utf8')).toBe(before);
    expect((await fs.stat(gatewayConfig)).mtimeMs).toBe(mtime);
  });

  it.each([true, false, undefined])('preserves previous enabled=%s and entry after an automatic discovery miss', async enabled => {
    const previous = { ...(enabled !== undefined ? { enabled } : {}), cliPath: '/missing/openclaw.mjs', captureMessageContent: false };
    await fs.writeFile(configPath, JSON.stringify({ agents: { openclaw: previous } }));
    const config = await writeConfig(probe(false), 'codex');
    expect(config.agents.openclaw).toEqual(previous);
    expect(config.agents.codex.enabled).toBe(true);
  });
  it('still honors an explicit disable selection', async () => {
    await fs.writeFile(configPath, JSON.stringify({ agents: { openclaw: { enabled: true } } }));
    expect((await writeConfig(probe(false), 'codex', true)).agents.openclaw.enabled).toBe(false);
  });
  it('does not enable a missing OpenClaw on first installation', async () => {
    expect((await writeConfig(probe(false), 'codex')).agents.openclaw.enabled).toBe(false);
  });
  it('round-trips entry paths with spaces, Unicode and shell metacharacters as data', async () => {
    const entry = '/opt/test 空格/quote\'"$`/openclaw.mjs';
    expect((await writeConfig(probe(true, entry))).agents.openclaw.cliPath).toBe(entry);
  });
});
