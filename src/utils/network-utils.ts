import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import { readInstalledVersion } from './fs-utils.js';

const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_ADDRESS = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`);

function directEgressIp(): string | undefined {
  if (process.env.VITEST === 'true') return undefined;
  try {
    const output = execFileSync('curl', [
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
    });
    const ip = String(output).trim();
    return IPV4_ADDRESS.test(ip) ? ip : undefined;
  } catch {
    return undefined;
  }
}

export function resolveLocalIp(): string {
  const egress = directEgressIp();
  if (egress) return egress;
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

export function refreshLocalIp(): void {
  const egress = resolveLocalIp();
  if (egress) LOCAL_IP = egress;
}

export function buildUserAgent(dataDir: string): string {
  const version = readInstalledVersion(dataDir);
  return `loongsuite-pilot/${version} (${os.type()}; ${os.release()}; ${os.arch()}) ip/${LOCAL_IP}`;
}
