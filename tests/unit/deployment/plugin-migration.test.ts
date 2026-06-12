import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runPluginMigration } from '../../../src/deployment/plugin-migration.js';

let TMP_HOME: string;
let originalHome: string;

beforeEach(() => {
  TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-migration-test-'));
  originalHome = process.env.HOME!;
  process.env.HOME = TMP_HOME;
});

afterEach(() => {
  process.env.HOME = originalHome;
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
});

function ensureDir(p: string) { fs.mkdirSync(p, { recursive: true }); }
function writeJson(p: string, data: unknown) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}
function writeText(p: string, content: string) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content, 'utf-8');
}

describe('plugin-migration: 无 cache 目录快速跳过', () => {
  test('Claude/Codex 都没装过老 plugin → migrated=false', async () => {
    const report = await runPluginMigration();
    expect(report.claude.migrated).toBe(false);
    expect(report.codex.migrated).toBe(false);
  });
});

describe('plugin-migration: Claude 清理', () => {
  test('清理 settings.json 中 otel-claude-hook 条目,保留用户其他 hook', async () => {
    // 模拟老 plugin 残留
    ensureDir(path.join(TMP_HOME, '.cache', 'opentelemetry.instrumentation.claude'));
    writeJson(path.join(TMP_HOME, '.claude', 'settings.json'), {
      hooks: {
        Stop: [
          { matcher: '*', hooks: [{ type: 'command', command: 'bash /tmp/.cache/opentelemetry.instrumentation.claude/hook-entry.sh stop' }] },
          { hooks: [{ command: '/Users/x/my-other-hook.sh', type: 'command' }] }, // 用户的不动
        ],
        PreToolUse: [
          { matcher: '*', hooks: [{ type: 'command', command: 'bash /Users/x/.cache/opentelemetry.instrumentation.claude/hook-entry.sh pre-tool-use' }] },
        ],
      },
    });

    const report = await runPluginMigration();
    expect(report.claude.migrated).toBe(true);

    // settings.json 里 otel 条目被删,用户其他 hook 保留
    const settings = JSON.parse(fs.readFileSync(path.join(TMP_HOME, '.claude', 'settings.json'), 'utf-8'));
    // PreToolUse 段只有 otel,清空后被整段删
    expect(settings.hooks.PreToolUse).toBeUndefined();
    // Stop 段保留用户的 my-other-hook.sh
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe('/Users/x/my-other-hook.sh');

    // cache 目录被删
    expect(fs.existsSync(path.join(TMP_HOME, '.cache', 'opentelemetry.instrumentation.claude'))).toBe(false);
  });

  test('清理 .bashrc / .zshrc 中 # BEGIN otel-claude-hook 段', async () => {
    ensureDir(path.join(TMP_HOME, '.cache', 'opentelemetry.instrumentation.claude'));
    writeText(path.join(TMP_HOME, '.bashrc'), [
      'export PATH=/usr/local/bin:$PATH',
      '',
      '# BEGIN otel-claude-hook',
      'alias claude="OTEL_BLAH=1 claude"',
      'export NODE_OPTIONS="--require /tmp/intercept.js"',
      '# END otel-claude-hook',
      '',
      'export FOO=bar',
    ].join('\n'));

    await runPluginMigration();

    const after = fs.readFileSync(path.join(TMP_HOME, '.bashrc'), 'utf-8');
    expect(after).not.toContain('# BEGIN otel-claude-hook');
    expect(after).not.toContain('alias claude=');
    expect(after).toContain('export FOO=bar');
    expect(after).toContain('export PATH=');
  });

  test('删除 ~/.claude/otel-config.json', async () => {
    ensureDir(path.join(TMP_HOME, '.cache', 'opentelemetry.instrumentation.claude'));
    writeJson(path.join(TMP_HOME, '.claude', 'otel-config.json'), { log_enabled: true });

    await runPluginMigration();

    expect(fs.existsSync(path.join(TMP_HOME, '.claude', 'otel-config.json'))).toBe(false);
  });
});

describe('plugin-migration: Codex 清理', () => {
  test('清理 hooks.json 中 otel-codex-hook 条目', async () => {
    ensureDir(path.join(TMP_HOME, '.cache', 'opentelemetry.instrumentation.codex'));
    writeJson(path.join(TMP_HOME, '.codex', 'hooks.json'), {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'bash /Users/x/.cache/opentelemetry.instrumentation.codex/hook-entry.sh session-start' }] },
        ],
        Stop: [
          { hooks: [{ type: 'command', command: 'bash /Users/x/.cache/opentelemetry.instrumentation.codex/hook-entry.sh stop' }] },
        ],
      },
    });

    const report = await runPluginMigration();
    expect(report.codex.migrated).toBe(true);

    // hooks.json 全是 otel 条目 → 整文件被删
    expect(fs.existsSync(path.join(TMP_HOME, '.codex', 'hooks.json'))).toBe(false);
  });

  test('config.toml 清 # OpenTelemetry instrumentation hooks marker 段 + codex_hooks alias', async () => {
    ensureDir(path.join(TMP_HOME, '.cache', 'opentelemetry.instrumentation.codex'));
    const tomlContent = [
      '[features]',
      'codex_hooks = true',
      '',
      '# OpenTelemetry instrumentation hooks',
      '[[hooks.SessionStart]]',
      '',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "otel-codex-hook session-start"',
      '',
      '[[hooks.Stop]]',
      '',
      '[[hooks.Stop.hooks]]',
      'type = "command"',
      'command = "otel-codex-hook stop"',
      '',
      '[other]',
      'foo = "bar"',
    ].join('\n');
    writeText(path.join(TMP_HOME, '.codex', 'config.toml'), tomlContent);

    await runPluginMigration();

    const after = fs.readFileSync(path.join(TMP_HOME, '.codex', 'config.toml'), 'utf-8');
    expect(after).not.toContain('# OpenTelemetry instrumentation hooks');
    expect(after).not.toContain('codex_hooks');
    expect(after).not.toContain('otel-codex-hook');
    expect(after).not.toContain('[features]'); // 空 features 被一并删
    expect(after).toContain('[other]'); // 用户其他配置保留
    expect(after).toContain('foo = "bar"');
  });

  test('config.toml 不动 BEGIN/END trust block (留给 hook-strategy 自然替换)', async () => {
    ensureDir(path.join(TMP_HOME, '.cache', 'opentelemetry.instrumentation.codex'));
    const tomlContent = [
      '# BEGIN otel-codex-hook trust',
      '[hooks.state."/abs/hooks.json:session_start:0:0"]',
      'trusted_hash = "sha256:abc"',
      '# END otel-codex-hook trust',
    ].join('\n');
    writeText(path.join(TMP_HOME, '.codex', 'config.toml'), tomlContent);

    await runPluginMigration();

    const after = fs.readFileSync(path.join(TMP_HOME, '.codex', 'config.toml'), 'utf-8');
    expect(after).toContain('# BEGIN otel-codex-hook trust');
    expect(after).toContain('# END otel-codex-hook trust');
  });

  test('cache 目录被删', async () => {
    const cache = path.join(TMP_HOME, '.cache', 'opentelemetry.instrumentation.codex');
    ensureDir(path.join(cache, 'sessions'));
    writeText(path.join(cache, 'hook-entry.sh'), '#!/bin/bash');

    await runPluginMigration();

    expect(fs.existsSync(cache)).toBe(false);
  });
});

describe('plugin-migration: fail-open', () => {
  test('settings.json 是无效 JSON 也不抛错', async () => {
    ensureDir(path.join(TMP_HOME, '.cache', 'opentelemetry.instrumentation.claude'));
    writeText(path.join(TMP_HOME, '.claude', 'settings.json'), '{ this is not json');

    const report = await runPluginMigration();
    expect(report.claude.migrated).toBe(true); // 仍标 migrated(因 cache 目录被检测到)
    // 不抛错
  });
});
