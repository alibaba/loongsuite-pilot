import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { dirname, resolve } from 'node:path';
import { configJsonPath, pickDataDir, readEnvDataDir } from '../utils/data-dir.js';
import { readJsonFile, resolveHome } from '../utils/fs-utils.js';
import {
  DEFAULT_DASHBOARD_HOST, DASHBOARD_ID_HEADER, DASHBOARD_ID_VALUE,
  DASHBOARD_INSTANCE_HEADER, dashboardInstanceId, resolveDashboardPort,
} from '../dashboard/dashboard-config.js';

export interface DashboardTarget {
  url: string;
  port: number;
  dataDir: string;
}

/** Read only the same config fields the collector uses; never initialize it. */
export async function loadDashboardTarget(): Promise<DashboardTarget> {
  const file = await readJsonFile<{ dataDir?: string; dashboard?: { port?: unknown } }>(configJsonPath());
  const dataDir = resolveHome(pickDataDir(readEnvDataDir(), file?.dataDir));
  const port = resolveDashboardPort(file?.dashboard?.port);
  return { url: `http://${DEFAULT_DASHBOARD_HOST}:${port}/`, port, dataDir };
}

export function probeDashboard(target: DashboardTarget, timeoutMs = 2_000): Promise<boolean> {
  return new Promise(resolve => {
    let finished = false;
    const finish = (available: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.destroy();
      resolve(available);
    };
    // node:http connects directly: no proxy environment, redirects, or curlrc.
    const req = request({
      host: DEFAULT_DASHBOARD_HOST,
      port: target.port,
      path: '/metrics-summary.json',
      method: 'HEAD',
      agent: false,
    }, response => {
      // 503 is normal before the first metrics snapshot is ready.
      finish((response.statusCode === 200 || response.statusCode === 503)
        && response.headers[DASHBOARD_ID_HEADER] === DASHBOARD_ID_VALUE
        && response.headers[DASHBOARD_INSTANCE_HEADER] === dashboardInstanceId(target.dataDir));
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
    req.on('error', () => finish(false));
    req.end();
  });
}

export function openDefaultBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', [url], { timeout: 5_000 }, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

type ShortcutAction = 'install' | 'status' | 'uninstall';
interface ShortcutResult {
  shortcutPath: string;
  exists: boolean;
  managed: boolean;
  url: string | null;
  dockMatches: number;
  dockLocked: boolean;
  changed: boolean;
  backupPath: string | null;
  warnings: string[];
}

async function runNativeShortcut(action: ShortcutAction, url?: string): Promise<ShortcutResult> {
  // The installed entry point lives in <version>/dist, alongside assets/scripts.
  const packageRoot = resolve(dirname(process.argv[1]), '..');
  const script = resolve(packageRoot, 'scripts/manage-dashboard-shortcut.js');
  const iconPath = resolve(packageRoot, 'assets/dashboard-launcher/AppIcon.icns');
  const iconVersion = action === 'install' ? createHash('sha256').update(await readFile(iconPath)).digest('hex') : undefined;
  const request = JSON.stringify({ action, url, configPath: resolve(configJsonPath()), iconPath, iconVersion });
  const output = await new Promise<string>((resolveOutput, reject) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', script, request],
      { timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) reject(new Error('Cannot run the macOS shortcut helper. Check the Pilot installation.'));
        else resolveOutput(stdout);
      });
  });
  const response = JSON.parse(output) as { ok: boolean; result: ShortcutResult; error?: string };
  if (!response.ok) throw new ShortcutError(response.error || 'Shortcut operation failed.');
  return response.result;
}

class ShortcutError extends Error {}

interface DashboardCommandDependencies {
  loadTarget?: typeof loadDashboardTarget;
  probe?: typeof probeDashboard;
  openBrowser?: typeof openDefaultBrowser;
  shortcut?: typeof runNativeShortcut;
  platform?: NodeJS.Platform;
  language?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export async function runDashboardCommand(
  args: string[], dependencies: DashboardCommandDependencies = {},
): Promise<number> {
  const out = dependencies.stdout ?? (text => process.stdout.write(text));
  const err = dependencies.stderr ?? (text => process.stderr.write(text));
  const zh = (dependencies.language ?? process.env.LOONGSUITE_PILOT_LANG ?? process.env.LANG ?? '').startsWith('zh');
  const message = (chinese: string, english: string) => zh ? chinese : english;
  if (args[0] === 'shortcut') {
    if (args.length !== 2 || !['install', 'status', 'uninstall'].includes(args[1])) {
      out('Usage: loongsuite-pilot dashboard shortcut {install|status|uninstall}\n');
      return args.length === 2 && ['--help', '-h'].includes(args[1]) ? 0 : 2;
    }
    if ((dependencies.platform ?? process.platform) !== 'darwin') {
      err(message('Dashboard 快捷方式目前仅支持 macOS。\n', 'Dashboard shortcuts currently support macOS only.\n'));
      return 1;
    }
    try {
      const action = args[1] as ShortcutAction;
      // Status/uninstall remain usable even after config.json is removed or broken.
      const target = action === 'install' ? await (dependencies.loadTarget ?? loadDashboardTarget)() : undefined;
      const result = await (dependencies.shortcut ?? runNativeShortcut)(action, target?.url);
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
      // Only print our native helper's controlled errors, never config/parser output.
      err(error instanceof ShortcutError ? `${error.message}\n` : message('请检查 Pilot 配置、安装文件和目录权限。\n', 'Check the Pilot configuration, installed files, and directory permissions.\n'));
      return 1;
    }
  }
  if (args.length !== 1 || !['open', 'url'].includes(args[0])) {
    out('Usage: loongsuite-pilot dashboard {open|url|shortcut {install|status|uninstall}}\n');
    return args.length === 1 && ['--help', '-h'].includes(args[0]) ? 0 : 2;
  }
  if (args[0] === 'open' && (dependencies.platform ?? process.platform) !== 'darwin') {
    err(message('浏览器启动器目前仅支持 macOS；可用 dashboard url 查看地址。\n',
      'Browser launching currently supports macOS only; use dashboard url to print the address.\n'));
    return 1;
  }

  let target: DashboardTarget;
  try {
    target = await (dependencies.loadTarget ?? loadDashboardTarget)();
  } catch {
    // Do not echo parser errors: they can include secrets from config.json.
    err(message('无法读取 Pilot 的 Dashboard 配置。请检查配置文件。\n',
      'Cannot read the Pilot Dashboard configuration. Please check the config file.\n'));
    return 1;
  }
  if (args[0] === 'url') {
    out(`${target.url}\n`);
    return 0;
  }
  if (!await (dependencies.probe ?? probeDashboard)(target)) {
    err(message(`无法连接对应的 Pilot Dashboard：${target.url}\n请检查 loongsuite-pilot status；若刚修改端口，需要重启 Pilot 后重试。此操作不会启停服务。\n`,
      `The matching Pilot Dashboard is not available at ${target.url}\nCheck loongsuite-pilot status. If you changed the port, restart Pilot before retrying. No service was started or stopped.\n`));
    return 1;
  }
  try {
    await (dependencies.openBrowser ?? openDefaultBrowser)(target.url);
  } catch {
    err(message(`无法调用默认浏览器。请检查 macOS 的默认浏览器设置，或手动打开 ${target.url}\n`,
      `Cannot open the default browser. Check the macOS default browser setting, or open ${target.url} manually.\n`));
    return 1;
  }
  out(`${target.url}\n`);
  return 0;
}
