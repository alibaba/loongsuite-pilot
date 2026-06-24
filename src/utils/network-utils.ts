import * as os from 'node:os';
import { readInstalledVersion } from './fs-utils.js';

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

export const LOCAL_IP = resolveLocalIp();

export function buildUserAgent(dataDir: string): string {
  const version = readInstalledVersion(dataDir);
  return `loongsuite-pilot/${version} (${os.type()}; ${os.release()}; ${os.arch()}) ip/${LOCAL_IP}`;
}
