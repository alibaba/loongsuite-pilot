import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { HookStrategy } from '../../../src/deployment/hook-strategy.js';
import { HookManager, type HookDefinition } from '../../../src/hooks/hook-manager.js';
import {
  computeInstalledHookTrustHash,
  type InstalledCodexHookLocation,
} from '../../../src/deployment/codex-trust-writer.js';
import type { AgentDefinition } from '../../../src/types/index.js';

let tmpDir: string;
let codexDir: string;
let hooksPath: string;
let configPath: string;
let hookCommand: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-trust-deploy-'));
  codexDir = path.join(tmpDir, '.codex');
  hooksPath = path.join(codexDir, 'hooks.json');
  configPath = path.join(codexDir, 'config.toml');
  hookCommand = path.join(tmpDir, 'codex-hook.sh');
  fs.mkdirSync(codexDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function location(eventName: 'Stop' | 'PreToolUse'): InstalledCodexHookLocation {
  const eventKey = eventName === 'Stop' ? 'stop' : 'pre_tool_use';
  const subcommand = eventName === 'Stop' ? 'stop' : 'pre-tool-use';
  return {
    eventName,
    eventKey,
    groupIndex: 0,
    handlerIndex: 0,
    matcher: '*',
    handler: { type: 'command', command: `${hookCommand} ${subcommand}` },
  };
}

function codexDefinition(): AgentDefinition {
  return {
    id: 'codex',
    displayName: 'Codex',
    deployMode: 'hook',
    detection: { paths: [codexDir], commands: [] },
    hook: {
      settingsPath: hooksPath,
      events: ['Stop'],
      retiredEvents: ['PreToolUse'],
      hookCommand,
      format: 'nested',
      matcher: '*',
      eventSubcommand: 'kebab-case',
      trustToml: {
        configPath,
        trustAlgo: 'v1',
        marker: 'otel-codex-hook',
      },
    },
  };
}

function writeInstalledHooks(): void {
  fs.writeFileSync(hooksPath, `${JSON.stringify({
    hooks: {
      Stop: [{ matcher: '*', hooks: [{ type: 'command', command: `${hookCommand} stop` }] }],
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `${hookCommand} pre-tool-use` }] }],
    },
  }, null, 2)}\n`);
}

function writeDuplicateTrust(): { currentKey: string; retiredKey: string; thirdParty: string } {
  const currentKey = `${hooksPath}:stop:0:0`;
  const retiredKey = `${hooksPath}:pre_tool_use:0:0`;
  const currentHash = computeInstalledHookTrustHash(location('Stop'));
  const retiredHash = computeInstalledHookTrustHash(location('PreToolUse'));
  const thirdParty = '["hooks"."state"."third-party:stop:0:0"]\nenabled = true\ntrusted_hash = "sha256:OTHER"\n';
  fs.writeFileSync(configPath,
    `[hooks.state."${retiredKey}"]\ntrusted_hash = "${retiredHash}"\n\n`
    + `["hooks"."state"."${retiredKey}"]\ntrusted_hash = "${retiredHash}"\n\n`
    + `[hooks.state."${currentKey}"]\ntrusted_hash = "${currentHash}"\n\n`
    + `["hooks"."state"."${currentKey}"]\nenabled = false\ntrusted_hash = "${currentHash}"\n\n`
    + thirdParty,
  );
  return { currentKey, retiredKey, thirdParty };
}

describe('Codex deploy trust reconciliation', () => {
  test('repairs duplicate retired and current trust before removing the retired hook', async () => {
    writeInstalledHooks();
    const { currentKey, retiredKey, thirdParty } = writeDuplicateTrust();
    const strategy = new HookStrategy(new HookManager(path.join(tmpDir, 'pilot-hooks'), path.join(tmpDir, 'logs')));

    const result = await strategy.deploy(codexDefinition());

    expect(result.success).toBe(true);
    const repaired = fs.readFileSync(configPath, 'utf8');
    const state = (parseToml(repaired) as any).hooks.state;
    expect(state[retiredKey]).toBeUndefined();
    expect(state[currentKey]).toEqual({
      enabled: false,
      trusted_hash: computeInstalledHookTrustHash(location('Stop')),
    });
    expect(repaired).toContain(thirdParty);
    expect((JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as any).hooks.PreToolUse).toBeUndefined();

    const mtimeBeforeRetry = fs.statSync(configPath, { bigint: true }).mtimeNs;
    const retry = await strategy.deploy(codexDefinition());
    expect(retry.success).toBe(true);
    expect(fs.statSync(configPath, { bigint: true }).mtimeNs).toBe(mtimeBeforeRetry);
  });

  test('retries retired hook removal without rewriting already reconciled trust', async () => {
    writeInstalledHooks();
    writeDuplicateTrust();
    const realManager = new HookManager(path.join(tmpDir, 'pilot-hooks'), path.join(tmpDir, 'logs'));
    let failRemoval = true;
    const manager = {
      isHookInstalled: (def: HookDefinition) => realManager.isHookInstalled(def),
      installHook: (def: HookDefinition) => realManager.installHook(def),
      uninstallHook: (def: HookDefinition) => {
        if (failRemoval && def.hookJsonPath.at(-1) === 'PreToolUse') {
          failRemoval = false;
          return Promise.resolve(false);
        }
        return realManager.uninstallHook(def);
      },
    };
    const strategy = new HookStrategy(manager as HookManager);

    const first = await strategy.deploy(codexDefinition());
    expect(first.success).toBe(false);
    expect(first.error).toContain('failed to remove retired hook event');
    expect((JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as any).hooks.PreToolUse).toBeDefined();

    const mtimeBeforeRetry = fs.statSync(configPath, { bigint: true }).mtimeNs;
    const retry = await strategy.deploy(codexDefinition());
    expect(retry.success).toBe(true);
    expect(fs.statSync(configPath, { bigint: true }).mtimeNs).toBe(mtimeBeforeRetry);
    expect((JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as any).hooks.PreToolUse).toBeUndefined();
  });
});
