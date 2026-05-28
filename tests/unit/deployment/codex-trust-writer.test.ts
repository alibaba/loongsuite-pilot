import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  computeHookTrustHash,
  hookStateKey,
  writeTrustedHashes,
  removeTrustBlock,
  verifyTrustHashes,
} from '../../../src/deployment/codex-trust-writer.js';

let TMP: string;
let configPath: string;

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-trust-test-'));
  configPath = path.join(TMP, 'config.toml');
});

afterEach(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
const ENTRY_PATH = '/abs/hook.sh';
const EVENT_TO_CMD: Record<string, string> = {
  SessionStart: `${ENTRY_PATH} session-start`,
  UserPromptSubmit: `${ENTRY_PATH} user-prompt-submit`,
  PreToolUse: `${ENTRY_PATH} pre-tool-use`,
  PostToolUse: `${ENTRY_PATH} post-tool-use`,
  Stop: `${ENTRY_PATH} stop`,
};
const EVENT_TO_GROUP_0: Record<string, number> = {
  SessionStart: 0, UserPromptSubmit: 0, PreToolUse: 0, PostToolUse: 0, Stop: 0,
};

describe('codex-trust-writer 算法', () => {
  test('computeHookTrustHash 是确定性的', () => {
    const a = computeHookTrustHash('SessionStart', 'bash /a session-start');
    const b = computeHookTrustHash('SessionStart', 'bash /a session-start');
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('command 不同 → hash 不同', () => {
    const a = computeHookTrustHash('SessionStart', 'bash /a session-start');
    const b = computeHookTrustHash('SessionStart', 'bash /b session-start');
    expect(a).not.toBe(b);
  });

  test('hookStateKey 格式 path:event_label:0:0', () => {
    const k = hookStateKey('/abs/hooks.json', 'SessionStart');
    expect(k).toBe('/abs/hooks.json:session_start:0:0');
  });

  test('未知 event 抛错', () => {
    expect(() => computeHookTrustHash('Unknown', 'cmd')).toThrow(/Unknown hook event/);
  });
});

describe('writeTrustedHashes / verifyTrustHashes 闭环', () => {
  test('write 后 verify 通过', () => {
    writeTrustedHashes({
      configPath,
      hooksJsonAbsPath: '/abs/hooks.json',
      hookEvents: HOOK_EVENTS,
      eventToCommand: EVENT_TO_CMD,
      eventToGroupIndex: EVENT_TO_GROUP_0,
      marker: 'otel-codex-hook',
    });
    const result = verifyTrustHashes({
      configPath,
      hooksJsonAbsPath: '/abs/hooks.json',
      hookEvents: HOOK_EVENTS,
      eventToCommand: EVENT_TO_CMD,
      eventToGroupIndex: EVENT_TO_GROUP_0,
      marker: 'otel-codex-hook',
    });
    expect(result.valid).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  test('文件含 5 个 [hooks.state.*] 段', () => {
    writeTrustedHashes({
      configPath,
      hooksJsonAbsPath: '/abs/hooks.json',
      hookEvents: HOOK_EVENTS,
      eventToCommand: EVENT_TO_CMD,
      eventToGroupIndex: EVENT_TO_GROUP_0,
      marker: 'otel-codex-hook',
    });
    const content = fs.readFileSync(configPath, 'utf-8');
    expect((content.match(/\[hooks\.state\."/g) || []).length).toBe(5);
    expect(content).toContain('# BEGIN otel-codex-hook trust');
    expect(content).toContain('# END otel-codex-hook trust');
  });

  test('forceBypass=true 时写入 bypass_hook_trust = true', () => {
    writeTrustedHashes({
      configPath,
      hooksJsonAbsPath: '/abs/hooks.json',
      hookEvents: HOOK_EVENTS,
      eventToCommand: EVENT_TO_CMD,
      eventToGroupIndex: EVENT_TO_GROUP_0,
      marker: 'otel-codex-hook',
      forceBypass: true,
    });
    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('bypass_hook_trust = true');
  });

  test('幂等重写: 两次 write 不产生重复段', () => {
    const opts = {
      configPath,
      hooksJsonAbsPath: '/abs/hooks.json',
      hookEvents: HOOK_EVENTS,
      eventToCommand: EVENT_TO_CMD,
      eventToGroupIndex: EVENT_TO_GROUP_0,
      marker: 'otel-codex-hook',
    } as const;
    writeTrustedHashes(opts);
    writeTrustedHashes(opts);
    const content = fs.readFileSync(configPath, 'utf-8');
    expect((content.match(/# BEGIN otel-codex-hook trust/g) || []).length).toBe(1);
    expect((content.match(/\[hooks\.state\."/g) || []).length).toBe(5);
  });

  test('清裸残留 (老插件留下的 [hooks.state."<own>:event:0:0"])', () => {
    // 模拟老 plugin 残留:已有 5 个裸的 hooks.state 条目,无 BEGIN/END marker
    const stale = HOOK_EVENTS.map((e) => {
      const k = hookStateKey('/abs/hooks.json', e);
      return `[hooks.state."${k}"]\ntrusted_hash = "sha256:STALE"\n`;
    }).join('\n');
    fs.writeFileSync(configPath, stale, 'utf-8');

    writeTrustedHashes({
      configPath,
      hooksJsonAbsPath: '/abs/hooks.json',
      hookEvents: HOOK_EVENTS,
      eventToCommand: EVENT_TO_CMD,
      eventToGroupIndex: EVENT_TO_GROUP_0,
      marker: 'otel-codex-hook',
    });
    const content = fs.readFileSync(configPath, 'utf-8');
    // 不应有 STALE
    expect(content).not.toContain('STALE');
    // 应只剩 BEGIN/END 块内 5 段
    expect((content.match(/\[hooks\.state\."/g) || []).length).toBe(5);
  });

  test('removeTrustBlock 逐条精确删除 trust 条目 + marker 注释,不删用户数据', () => {
    // 模拟 codex 桌面版把用户数据夹在 BEGIN/END 之间的场景
    const trustAndUserData = [
      '# BEGIN otel-codex-hook trust',
      '[hooks.state."/abs/hooks.json:session_start:0:0"]',
      'trusted_hash = "sha256:abc"',
      '',
      '[marketplaces.openai-bundled]',
      'source_type = "local"',
      '',
      '# END otel-codex-hook trust',
    ].join('\n');
    fs.writeFileSync(configPath, trustAndUserData, 'utf-8');

    const removed = removeTrustBlock(configPath, 'otel-codex-hook', '/abs/hooks.json', HOOK_EVENTS);
    expect(removed).toBe(true);
    const content = fs.readFileSync(configPath, 'utf-8');
    // trust 条目 + marker 都被删
    expect(content).not.toContain('BEGIN otel-codex-hook trust');
    expect(content).not.toContain('END otel-codex-hook trust');
    expect(content).not.toContain('hooks.state');
    expect(content).not.toContain('trusted_hash');
    // 用户的 marketplace 数据保留
    expect(content).toContain('[marketplaces.openai-bundled]');
    expect(content).toContain('source_type = "local"');
  });

  test('verify 检测 hash 不一致', () => {
    // 手工写一个错误 hash 的 trust block
    const k = hookStateKey('/abs/hooks.json', 'SessionStart');
    const fake = `# BEGIN otel-codex-hook trust\n[hooks.state."${k}"]\ntrusted_hash = "sha256:WRONG"\n# END otel-codex-hook trust\n`;
    fs.writeFileSync(configPath, fake, 'utf-8');
    const result = verifyTrustHashes({
      configPath,
      hooksJsonAbsPath: '/abs/hooks.json',
      hookEvents: ['SessionStart'],
      eventToCommand: { SessionStart: `${ENTRY_PATH} session-start` },
      eventToGroupIndex: { SessionStart: 0 },
      marker: 'otel-codex-hook',
    });
    expect(result.valid).toBe(false);
    expect(result.mismatches[0]).toMatch(/hash mismatch/);
  });

  test('保留非 pilot path 的 [hooks.state] 条目', () => {
    // 另一个 hooks.json 路径下的 trust state — 不属于 pilot,应保留
    const otherKey = '/other/hooks.json:session_start:0:0';
    const otherTrust = `[hooks.state."${otherKey}"]\ntrusted_hash = "sha256:OTHER"\n`;
    fs.writeFileSync(configPath, otherTrust, 'utf-8');

    writeTrustedHashes({
      configPath,
      hooksJsonAbsPath: '/abs/hooks.json',
      hookEvents: HOOK_EVENTS,
      eventToCommand: EVENT_TO_CMD,
      eventToGroupIndex: EVENT_TO_GROUP_0,
      marker: 'otel-codex-hook',
    });
    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('sha256:OTHER'); // 不同 path 的不动
    expect(content).toContain(`[hooks.state."${otherKey}"]`);
  });

  test('groupIndex != 0 时 trust key 用实际 index (修复第三方 hook 挤占问题)', () => {
    const groupIndex1: Record<string, number> = {
      SessionStart: 1, UserPromptSubmit: 1, PreToolUse: 2, PostToolUse: 2, Stop: 0,
    };
    writeTrustedHashes({
      configPath,
      hooksJsonAbsPath: '/abs/hooks.json',
      hookEvents: HOOK_EVENTS,
      eventToCommand: EVENT_TO_CMD,
      eventToGroupIndex: groupIndex1,
      marker: 'otel-codex-hook',
    });
    const content = fs.readFileSync(configPath, 'utf-8');
    // SessionStart 应该用 :1:0 而非 :0:0
    expect(content).toContain('[hooks.state."/abs/hooks.json:session_start:1:0"]');
    expect(content).not.toContain('[hooks.state."/abs/hooks.json:session_start:0:0"]');
    // PreToolUse 应该用 :2:0
    expect(content).toContain('[hooks.state."/abs/hooks.json:pre_tool_use:2:0"]');
    // Stop 还是 :0:0
    expect(content).toContain('[hooks.state."/abs/hooks.json:stop:0:0"]');

    // verify 也要用同样的 groupIndex
    const result = verifyTrustHashes({
      configPath,
      hooksJsonAbsPath: '/abs/hooks.json',
      hookEvents: HOOK_EVENTS,
      eventToCommand: EVENT_TO_CMD,
      eventToGroupIndex: groupIndex1,
      marker: 'otel-codex-hook',
    });
    expect(result.valid).toBe(true);
  });
});
