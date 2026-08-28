// One-shot macOS shortcut command, shipped directly in scripts/ without a build.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function shortcutConfigPath(env = process.env, home = homedir()) {
  // Match src/utils/data-dir.ts:configJsonPath; parity is tested against it.
  const path = (env.AGENT_DATA_COLLECTION_CONFIG ?? '').trim() || join(home, '.loongsuite-pilot/config.json');
  return resolve(path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path);
}

export async function loadShortcutUrl(configPath) {
  let file;
  try { file = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, '')); }
  catch { /* Match the collector's missing/unreadable/malformed config fallback. */ }
  // Match buildDashboardConfig without importing the collector or changing src/.
  const value = file?.dashboard?.port;
  const port = typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535 ? value : 8_765;
  return `http://127.0.0.1:${port}/`;
}

class ShortcutError extends Error {}

async function runNativeShortcut(action, configPath, url) {
  const script = fileURLToPath(new URL('./manage-dashboard-shortcut.js', import.meta.url));
  const iconPath = fileURLToPath(new URL('../assets/dashboard-shortcut/AppIcon.icns', import.meta.url));
  const iconVersion = action === 'install' ? createHash('sha256').update(await readFile(iconPath)).digest('hex') : undefined;
  const request = JSON.stringify({ action, url, configPath, iconPath, iconVersion });
  const output = await new Promise((resolveOutput, reject) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', script, request],
      { timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) reject(error);
        else resolveOutput(stdout);
      });
  });
  const response = JSON.parse(output);
  if (!response.ok) throw new ShortcutError(response.error || 'Shortcut operation failed.');
  return response.result;
}

export async function runShortcutCommand(args, dependencies = {}) {
  const out = dependencies.stdout ?? (text => process.stdout.write(text));
  const err = dependencies.stderr ?? (text => process.stderr.write(text));
  const zh = (dependencies.language ?? process.env.LOONGSUITE_PILOT_LANG ?? process.env.LANG ?? '').startsWith('zh');
  const message = (chinese, english) => zh ? chinese : english;
  if (args.length !== 1 || !['install', 'status', 'uninstall'].includes(args[0])) {
    out('Usage: loongsuite-pilot dashboard shortcut {install|status|uninstall}\n');
    return args.length === 1 && ['--help', '-h'].includes(args[0]) ? 0 : 2;
  }
  if ((dependencies.platform ?? process.platform) !== 'darwin') {
    err(message('Dashboard 快捷方式目前仅支持 macOS。\n', 'Dashboard shortcuts currently support macOS only.\n'));
    return 1;
  }
  try {
    const action = args[0];
    const configPath = (dependencies.configPath ?? shortcutConfigPath)();
    // Status/uninstall do not need the config file or icon asset to still exist.
    const url = action === 'install' ? await (dependencies.loadUrl ?? loadShortcutUrl)(configPath) : undefined;
    const result = await (dependencies.shortcut ?? runNativeShortcut)(action, configPath, url);
    const state = result.exists ? (result.managed ? message('已安装', 'installed') : message('未受本配置管理', 'not managed by this configuration')) : message('未安装', 'not installed');
    out(`${message('快捷方式', 'Shortcut')}: ${state}\n`);
    out(`${message('文件位置', 'File')}: ${result.shortcutPath}\n`);
    out(`${message('目标网址', 'Target URL')}: ${result.url ?? '-'}\n`);
    out(`${message('程序坞', 'Dock')}: ${result.dockMatches ? message('已添加', 'added') : message('未添加', 'not added')}${result.dockLocked ? message('（已锁定）', ' (locked)') : ''}\n`);
    if (result.dockMatches > 1) out(message('发现重复的程序坞入口，请手动清理。\n', 'Duplicate Dock entries found; remove duplicates manually.\n'));
    if (!result.exists && result.dockMatches) out(message('文件已不存在，请手动移除残留的程序坞入口。\n', 'The file is missing; remove its orphaned Dock entry manually.\n'));
    if (action === 'install') out(message('端口变更后请重新执行此安装命令；此操作不会启停 Pilot。\n', 'Run this install command again after changing the port. No Pilot service was started or stopped.\n'));
    if (action === 'uninstall' && result.changed) out(message('快捷文件已移到废纸篓；备份文件已保留。\n', 'The shortcut file was moved to Trash; backups were preserved.\n'));
    if (result.backupPath) out(`${message('程序坞备份', 'Dock backup')}: ${result.backupPath}\n`);
    for (const warning of result.warnings) err(`${warning}\n`);
    return 0;
  } catch (error) {
    err(message('快捷方式操作未完成。\n', 'Shortcut operation did not complete.\n'));
    // Only print controlled helper errors, never raw config/parser/process output.
    err(error instanceof ShortcutError ? `${error.message}\n` : message('请检查 Pilot 配置、安装文件和目录权限。\n', 'Check the Pilot configuration, installed files, and directory permissions.\n'));
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runShortcutCommand(process.argv.slice(2));
}
