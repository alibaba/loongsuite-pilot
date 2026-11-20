import * as os from 'node:os';
import { readInstalledVersion } from './fs-utils.js';

export function selectPrimaryIpv4(
  interfaces: ReturnType<typeof os.networkInterfaces>,
): { address: string; mac: string } {
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (!iface.internal && iface.family === 'IPv4') {
        const mac = iface.mac.trim().toLowerCase();
        return { address: iface.address, mac: mac === '00:00:00:00:00:00' ? '' : mac };
      }
    }
  }
  return { address: '127.0.0.1', mac: '' };
}

export function resolveLocalIp(): string {
  return selectPrimaryIpv4(os.networkInterfaces()).address;
}

const primaryIpv4 = selectPrimaryIpv4(os.networkInterfaces());
export const LOCAL_IP = primaryIpv4.address;
export const LOCAL_MAC = primaryIpv4.mac;

export function buildUserAgent(dataDir: string): string {
  const version = readInstalledVersion(dataDir);
  return `loongsuite-pilot/${version} (${os.type()}; ${os.release()}; ${os.arch()}) ip/${LOCAL_IP}`;
}
