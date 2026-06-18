// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * db-path.mjs — Kiro CLI transcript DB 路径平台化 resolver。
 *
 * 优先级（用户实现约束，禁止硬编码 Linux 路径）：
 *   1. 环境变量 KIRO_CLI_DB（直接指向 db 文件）
 *   2. KIRO_CLI_DATA_DIR/data.sqlite3
 *   3. 平台默认：
 *        macOS   ~/Library/Application Support/kiro-cli/data.sqlite3
 *        Linux   ~/.local/share/kiro-cli/data.sqlite3
 *        Windows %APPDATA%/kiro-cli/data.sqlite3
 *
 * resolveDbDir() 返回不含 data.sqlite3 的目录；resolveDbPath() 返回完整文件路径。
 */

import os from 'node:os';
import path from 'node:path';

const DB_FILE_NAME = 'data.sqlite3';
const DATA_DIR_NAME = 'kiro-cli';

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * 解析 Kiro CLI transcript DB 所在目录。
 * @returns {string}
 */
export function resolveDbDir() {
  if (process.env.KIRO_CLI_DATA_DIR) {
    return expandHome(process.env.KIRO_CLI_DATA_DIR);
  }
  return defaultDataDir();
}

/**
 * 解析 Kiro CLI transcript DB 文件路径。
 * 优先级见文件头注释。
 * @returns {string}
 */
export function resolveDbPath() {
  if (process.env.KIRO_CLI_DB) {
    return expandHome(process.env.KIRO_CLI_DB);
  }
  if (process.env.KIRO_CLI_DATA_DIR) {
    return path.join(resolveDbDir(), DB_FILE_NAME);
  }
  return path.join(defaultDataDir(), DB_FILE_NAME);
}

function defaultDataDir() {
  const platform = process.platform;
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', DATA_DIR_NAME);
  }
  if (platform === 'win32') {
    const appdata = process.env.APPDATA;
    if (appdata) return path.join(appdata, DATA_DIR_NAME);
    return path.join(os.homedir(), 'AppData', 'Roaming', DATA_DIR_NAME);
  }
  // Linux / 其它 POSIX：遵循 XDG_DATA_HOME
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path.join(expandHome(xdg), DATA_DIR_NAME);
  return path.join(os.homedir(), '.local', 'share', DATA_DIR_NAME);
}
