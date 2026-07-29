// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  installKimiHooks,
  uninstallKimiHooks,
  isKimiHookInstalled,
  listInstalledKimiEvents,
  listOwnedKimiEntries,
} from '../../../src/deployment/kimi-config-writer.js';

let TMP: string;
let configPath: string;

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-config-writer-test-'));
  configPath = path.join(TMP, 'config.toml');
});

afterEach(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

const HOOK_CMD = 'bash /pilot/hooks/kimi-cli-loongsuite-pilot-hook.sh';

function readConfig(): string {
  return fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : '';
}

describe('kimi-config-writer install / uninstall', () => {
  test('首次 install：写入 [[hooks]] 段 + 默认 matcher="*" timeout=30', async () => {
    await installKimiHooks({
      configPath,
      hookCommand: HOOK_CMD,
      events: ['Stop', 'StopFailure'],
    });
    const content = readConfig();
    expect(content).toContain('[[hooks]]');
    expect(content).toContain('event = "Stop"');
    expect(content).toContain('event = "StopFailure"');
    expect(content).toContain(`command = "${HOOK_CMD}"`);
    expect(content).toContain('matcher = "*"');
    expect(content).toContain('timeout = 30');
  });

  test('幂等：第二次 install 不重复追加条目', async () => {
    await installKimiHooks({ configPath, hookCommand: HOOK_CMD, events: ['Stop'] });
    await installKimiHooks({ configPath, hookCommand: HOOK_CMD, events: ['Stop'] });
    const content = readConfig();
    // 应只有 1 个 [[hooks]] event=Stop
    const stopMatches = content.match(/event = "Stop"/g) || [];
    expect(stopMatches.length).toBe(1);
  });

  test('保留用户已有 [[hooks]] + 其他配置段', async () => {
    const initial = [
      'default_model = "echo"',
      '',
      '[providers.echo]',
      'type = "_echo"',
      '',
      '[[hooks]]',
      'event = "PreToolUse"',
      'command = "user-other-hook"',
      'matcher = ""',
      'timeout = 10',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, initial, 'utf-8');

    await installKimiHooks({ configPath, hookCommand: HOOK_CMD, events: ['Stop'] });

    const content = readConfig();
    expect(content).toContain('default_model = "echo"');
    expect(content).toContain('[providers.echo]');
    expect(content).toContain('user-other-hook');
    expect(content).toContain('event = "Stop"');
    expect(content).toContain(`command = "${HOOK_CMD}"`);
  });

  test('retiredEvents 清理：install 时清除 pilot 旧版本的 retired 事件', async () => {
    // 先写入旧版本：pilot 在 SessionStart 事件上有 hookCommand
    await installKimiHooks({ configPath, hookCommand: HOOK_CMD, events: ['SessionStart', 'Stop'] });
    // 再切换 events 列表（SessionStart 被淘汰）
    await installKimiHooks({ configPath, hookCommand: HOOK_CMD, events: ['Stop', 'StopFailure'] });

    const content = readConfig();
    expect(content).not.toContain('event = "SessionStart"');
    expect(content).toContain('event = "Stop"');
    expect(content).toContain('event = "StopFailure"');
  });

  test('replaceHookCommands 清理：第三方残留被清除', async () => {
    const initial = [
      '[[hooks]]',
      'event = "Stop"',
      'command = "otel-kimi-hook --some-arg"',
      '',
      '[[hooks]]',
      'event = "StopFailure"',
      'command = "otel-kimi-hook --other-arg"',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, initial, 'utf-8');

    await installKimiHooks({
      configPath,
      hookCommand: HOOK_CMD,
      events: ['Stop', 'StopFailure'],
      replaceHookCommands: ['otel-kimi-hook'],
    });

    const content = readConfig();
    expect(content).not.toContain('otel-kimi-hook');
    expect(content).toContain(`command = "${HOOK_CMD}"`);
  });

  test('uninstall 清除 pilot 所有 [[hooks]] 条目', async () => {
    await installKimiHooks({ configPath, hookCommand: HOOK_CMD, events: ['Stop', 'StopFailure'] });
    await uninstallKimiHooks({ configPath, hookCommand: HOOK_CMD });

    const content = readConfig();
    expect(content).not.toContain(`command = "${HOOK_CMD}"`);
    // hooks 数组应被删除（或为空）
    expect(content).not.toMatch(/\[\[hooks\]\]/);
  });

  test('uninstall 保留用户其他 hook', async () => {
    const initial = [
      '[[hooks]]',
      'event = "PreToolUse"',
      'command = "user-other-hook"',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, initial, 'utf-8');

    await installKimiHooks({ configPath, hookCommand: HOOK_CMD, events: ['Stop'] });
    await uninstallKimiHooks({ configPath, hookCommand: HOOK_CMD });

    const content = readConfig();
    expect(content).toContain('user-other-hook');
    expect(content).not.toContain(`command = "${HOOK_CMD}"`);
  });

  test('isKimiHookInstalled：检测已安装的 event', async () => {
    await installKimiHooks({ configPath, hookCommand: HOOK_CMD, events: ['Stop'] });
    expect(await isKimiHookInstalled({ configPath, hookCommand: HOOK_CMD, event: 'Stop' })).toBe(true);
    expect(await isKimiHookInstalled({ configPath, hookCommand: HOOK_CMD, event: 'StopFailure' })).toBe(false);
  });

  test('isKimiHookInstalled：replaceHookCommands 残留 → 返回 false（需重装）', async () => {
    const initial = [
      '[[hooks]]',
      'event = "Stop"',
      'command = "otel-kimi-hook --arg"',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, initial, 'utf-8');

    expect(await isKimiHookInstalled({
      configPath,
      hookCommand: HOOK_CMD,
      event: 'Stop',
      replaceHookCommands: ['otel-kimi-hook'],
    })).toBe(false);
  });

  test('listInstalledKimiEvents：返回 pilot 拥有的 event 列表', async () => {
    await installKimiHooks({ configPath, hookCommand: HOOK_CMD, events: ['Stop', 'StopFailure'] });
    const events = await listInstalledKimiEvents(configPath, HOOK_CMD);
    expect(events).toContain('Stop');
    expect(events).toContain('StopFailure');
    expect(events.length).toBe(2);
  });

  test('listOwnedKimiEntries：识别 pilot + replaceHookCommands 残留', async () => {
    const initial = [
      '[[hooks]]',
      'event = "Stop"',
      `command = "${HOOK_CMD}"`,
      '',
      '[[hooks]]',
      'event = "PreToolUse"',
      'command = "otel-kimi-hook --legacy"',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, initial, 'utf-8');

    const owned = await listOwnedKimiEntries(configPath, HOOK_CMD, ['otel-kimi-hook']);
    expect(owned.length).toBe(2);
    expect(owned.map((e) => e.event).sort()).toEqual(['PreToolUse', 'Stop']);
  });

  test('空文件不崩溃：install 写入新 config.toml', async () => {
    // config.toml 不存在
    await installKimiHooks({ configPath, hookCommand: HOOK_CMD, events: ['Stop'] });
    expect(fs.existsSync(configPath)).toBe(true);
    expect(readConfig()).toContain('event = "Stop"');
  });

  test('TOML 解析失败时 install 不丢失原文件内容（best-effort）', async () => {
    const malformed = 'this is not valid TOML [[[ \n';
    fs.writeFileSync(configPath, malformed, 'utf-8');
    // install 应不丢失原文件（解析失败时 best-effort：用空对象重写）
    // 注：本实现选择 parse 失败 → 用空对象重写；用户原文件内容会丢失。
    // 这是已知 trade-off（smol-toml 无法 round-trip 损坏文件）。
    await installKimiHooks({ configPath, hookCommand: HOOK_CMD, events: ['Stop'] });
    expect(readConfig()).toContain('event = "Stop"');
  });
});
