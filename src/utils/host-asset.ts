import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createLogger } from './logger.js';

const logger = createLogger('HostAsset');

const SERIAL_PLACEHOLDERS = new Set([
  'none',
  'default string',
  'to be filled by o.e.m.',
  'system serial number',
  'not specified',
  '0',
]);

const LINUX_SERIAL_PATHS = [
  '/sys/class/dmi/id/product_serial',
  '/sys/class/dmi/id/board_serial',
  '/sys/class/dmi/id/chassis_serial',
];

function normalizeSerial(raw: string): string {
  const value = raw.trim();
  if (!value || SERIAL_PLACEHOLDERS.has(value.toLowerCase())) return '';
  return Buffer.byteLength(value) <= 128 ? value : '';
}

/** Read the hardware serial once. Any failure becomes an empty string. */
export function collectHostAsset(
  platform: NodeJS.Platform,
  readFile: (path: string) => string,
  execFile: (command: string, args: string[]) => string,
): string {
  try {
    if (platform === 'darwin') {
      const output = execFile('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
      const match = output.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]{0,128})"/);
      return match ? normalizeSerial(match[1]) : '';
    }
    if (platform === 'win32') {
      const output = execFile('powershell.exe', [
        '-NoProfile',
        '-WindowStyle',
        'Hidden',
        '-Command',
        [
          '$bios = (Get-CimInstance -ClassName Win32_BIOS).SerialNumber',
          '$product = (Get-CimInstance -ClassName Win32_ComputerSystemProduct).IdentifyingNumber',
          'Write-Output $bios',
          'Write-Output $product',
        ].join('; '),
      ]);
      for (const line of output.split(/\r?\n/)) {
        const serial = normalizeSerial(line);
        if (serial) return serial;
      }
      return '';
    }
    if (platform === 'linux') {
      for (const path of LINUX_SERIAL_PATHS) {
        try {
          const serial = normalizeSerial(readFile(path));
          if (serial) return serial;
        } catch {
          continue;
        }
      }
    }
    return '';
  } catch (err) {
    logger.warn('host serial collection failed', { error: String(err) });
    return '';
  }
}

export const LOCAL_SN = collectHostAsset(
  process.platform,
  (path) => fs.readFileSync(path, 'utf8'),
  (command, args) => execFileSync(command, args, {
    timeout: 3000,
    encoding: 'utf-8',
    maxBuffer: 256 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }),
);
