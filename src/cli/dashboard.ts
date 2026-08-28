import { execFile } from 'node:child_process';
import { request } from 'node:http';
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

interface DashboardCommandDependencies {
  loadTarget?: typeof loadDashboardTarget;
  probe?: typeof probeDashboard;
  openBrowser?: typeof openDefaultBrowser;
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
  if (args.length !== 1 || !['open', 'url'].includes(args[0])) {
    out('Usage: loongsuite-pilot dashboard {open|url}\n');
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
