import { execFile } from 'node:child_process';
import * as os from 'node:os';
import { readInstalledVersion } from './fs-utils.js';
import { createLogger } from './logger.js';

const logger = createLogger('NetworkUtils');

const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_ADDRESS = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`);

function probeFailure(err: unknown): { key: string; code?: number | string; error: string } {
  const error = err as { code?: unknown; killed?: boolean; stderr?: unknown };
  const detail = (String(error.stderr ?? '').trim() || String(err)).slice(0, 500);
  if (error.code === 'ENOENT') return { key: 'ENOENT', code: 'ENOENT', error: detail };
  if (error.killed || error.code === 'ETIMEDOUT') return { key: 'ETIMEDOUT', code: 'ETIMEDOUT', error: detail };
  const code = typeof error.code === 'number' ? error.code : undefined;
  return { key: String(code ?? 'error'), code, error: detail };
}

function directEgressIp(): Promise<{ ip?: string; key: string; code?: number | string; error?: string }> {
  return new Promise(resolve => {
    const child = execFile('curl', [
      '-4',
      '-fsS',
      '--max-time',
      '2',
      '--noproxy',
      '*',
      'https://ifconfig.me/ip',
    ], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      env: {
        ...process.env,
        http_proxy: '',
        https_proxy: '',
        all_proxy: '',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
      },
    }, (err, stdout) => {
      if (err) {
        resolve(probeFailure(err));
        return;
      }
      const ip = String(stdout).trim();
      if (IPV4_ADDRESS.test(ip)) {
        resolve({ ip, key: '' });
        return;
      }
      const body = ip.slice(0, 500) || 'empty';
      resolve({ key: 'invalid', error: `response is not an IPv4 address: ${body}` });
    });
    child?.unref();
  });
}

export function resolveLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (!iface.internal && iface.family === 'IPv4') {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

export let LOCAL_IP = resolveLocalIp();

let egressSeen = false;
let failureKey: string | undefined;
let refreshTask: Promise<void> | null = null;

async function refreshLocalIpOnce(): Promise<void> {
  if (process.env.VITEST === 'true') return;
  const result = await directEgressIp();
  if (result.ip) {
    if (!egressSeen || failureKey !== undefined) {
      logger.info('direct egress lookup succeeded');
    }
    LOCAL_IP = result.ip;
    egressSeen = true;
    failureKey = undefined;
    return;
  }
  if (!egressSeen) LOCAL_IP = resolveLocalIp();
  if (result.key === failureKey) return;
  logger.warn('direct egress lookup failed', {
    ...(result.code !== undefined ? { code: result.code } : {}),
    error: result.error,
  });
  failureKey = result.key;
}

export function refreshLocalIp(): Promise<void> {
  if (refreshTask) return refreshTask;
  refreshTask = refreshLocalIpOnce().finally(() => {
    refreshTask = null;
  });
  return refreshTask;
}

export function buildUserAgent(dataDir: string): string {
  const version = readInstalledVersion(dataDir);
  return `loongsuite-pilot/${version} (${os.type()}; ${os.release()}; ${os.arch()}) ip/${LOCAL_IP}`;
}
