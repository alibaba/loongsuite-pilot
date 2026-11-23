import { describe, expect, test, beforeEach, afterEach } from 'vitest';

// db-path.mjs 的 resolver 不含运行时副作用，可静态测；它内部用 process.env / process.platform。
// 通过临时覆盖 env 与 process.platform 验证优先级。
// ESM 模块按 URL 缓存，用 query 后缀强制重新求值，使 env/platform 变更生效。

const MODULE = '../../../../assets/hooks/kiro-cli/db-path.mjs';
let importCounter = 0;

function freshImport() {
  importCounter += 1;
  return import(`${MODULE}?v=${importCounter}`);
}

async function withPlatform(platform, fn) {
  const saved = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    if (saved) Object.defineProperty(process, 'platform', saved);
  }
}

describe('kiro-cli db-path resolver', () => {
  const SAVED_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.KIRO_CLI_DB;
    delete process.env.KIRO_CLI_DATA_DIR;
    delete process.env.XDG_DATA_HOME;
    delete process.env.APPDATA;
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in SAVED_ENV)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(SAVED_ENV)) process.env[k] = v;
  });

  test('KIRO_CLI_DB 优先级最高，原样返回', async () => {
    process.env.KIRO_CLI_DB = '/custom/path/kiro.db';
    const mod = await freshImport();
    expect(mod.resolveDbPath()).toBe('/custom/path/kiro.db');
  });

  test('KIRO_CLI_DATA_DIR → <dir>/data.sqlite3', async () => {
    process.env.KIRO_CLI_DATA_DIR = '/data/here';
    const mod = await freshImport();
    expect(mod.resolveDbPath()).toBe('/data/here/data.sqlite3');
    expect(mod.resolveDbDir()).toBe('/data/here');
  });

  test('Linux 默认：~/.local/share/kiro-cli/data.sqlite3（不硬编码其它路径）', async () => {
    await withPlatform('linux', async () => {
      const mod = await freshImport();
      const p = mod.resolveDbPath();
      expect(p.endsWith('/.local/share/kiro-cli/data.sqlite3')).toBe(true);
    });
  });

  test('macOS 默认：~/Library/Application Support/kiro-cli/data.sqlite3', async () => {
    await withPlatform('darwin', async () => {
      const mod = await freshImport();
      const p = mod.resolveDbPath();
      expect(p.endsWith('/Library/Application Support/kiro-cli/data.sqlite3')).toBe(true);
    });
  });

  test('Windows 默认：%APPDATA%/kiro-cli/data.sqlite3', async () => {
    await withPlatform('win32', async () => {
      process.env.APPDATA = 'C:/Users/me/AppData/Roaming';
      const mod = await freshImport();
      const p = mod.resolveDbPath().replace(/\\/g, '/');
      expect(p.endsWith('AppData/Roaming/kiro-cli/data.sqlite3')).toBe(true);
    });
  });

  test('Linux 尊重 XDG_DATA_HOME', async () => {
    await withPlatform('linux', async () => {
      process.env.XDG_DATA_HOME = '/xdg/data';
      const mod = await freshImport();
      expect(mod.resolveDbPath()).toBe('/xdg/data/kiro-cli/data.sqlite3');
    });
  });

  test('KIRO_CLI_DB 优先级高于 KIRO_CLI_DATA_DIR', async () => {
    process.env.KIRO_CLI_DB = '/wins/kiro.db';
    process.env.KIRO_CLI_DATA_DIR = '/loses';
    const mod = await freshImport();
    expect(mod.resolveDbPath()).toBe('/wins/kiro.db');
  });
});
