import { describe, expect, it, vi } from 'vitest';
import { collectHostAsset } from '../../../src/utils/host-asset.js';
import { selectPrimaryIpv4 } from '../../../src/utils/network-utils.js';
import type * as os from 'node:os';

function ipv4(address: string, mac: string, internal = false): os.NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.0', family: 'IPv4', mac, internal, cidr: null };
}

function ipv6(address: string, mac: string): os.NetworkInterfaceInfo {
  return { address, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac, internal: false, cidr: null, scopeid: 0 };
}

function unread(): string {
  throw new Error('unread');
}

function notExecuted(): string {
  throw new Error('not executed');
}

describe('selectPrimaryIpv4', () => {
  it('uses the MAC of the same NIC as the first non-internal IPv4', () => {
    expect(selectPrimaryIpv4({
      lo0: [ipv4('127.0.0.1', '00:00:00:00:00:00', true)],
      en0: [ipv4('10.0.0.8', 'AA:BB:CC:DD:EE:02'), ipv6('fe80::1', 'aa:bb:cc:dd:ee:02')],
      en1: [ipv4('192.168.1.9', '11:22:33:44:55:66')],
    })).toEqual({ address: '10.0.0.8', mac: 'aa:bb:cc:dd:ee:02' });
  });

  it('uses the loopback address when no external IPv4 exists', () => {
    expect(selectPrimaryIpv4({})).toEqual({ address: '127.0.0.1', mac: '' });
  });

  it('keeps the IP and drops a zero MAC on that NIC', () => {
    expect(selectPrimaryIpv4({
      en0: [ipv4('10.0.0.8', '00:00:00:00:00:00')],
      en1: [ipv4('192.168.1.9', '11:22:33:44:55:66')],
    })).toEqual({ address: '10.0.0.8', mac: '' });
  });
});

describe('collectHostAsset', () => {
  it('reads the macOS platform serial from one ioreg invocation', () => {
    const execFile = vi.fn(() => '"IOPlatformSerialNumber" = "C02XG0AHJG5H"');
    expect(collectHostAsset('darwin', unread, execFile)).toBe('C02XG0AHJG5H');
    expect(execFile).toHaveBeenCalledWith('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
  });

  it('drops a macOS serial longer than 128 characters', () => {
    const serial = 'A'.repeat(128);
    expect(collectHostAsset('darwin', unread, () => `"IOPlatformSerialNumber" = "${serial}"`)).toBe(serial);
    expect(collectHostAsset('darwin', unread, () => `"IOPlatformSerialNumber" = "${serial}B"`)).toBe('');
  });

  it('drops an OEM placeholder and keeps the later Windows product serial', () => {
    const execFile = vi.fn(() => 'To Be Filled By O.E.M.\r\nPF2ABCDE\r\n');
    expect(collectHostAsset('win32', unread, execFile)).toBe('PF2ABCDE');
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0][0]).toBe('powershell.exe');
    expect(execFile.mock.calls[0][1]).toEqual([
      '-NoProfile', '-WindowStyle', 'Hidden', '-Command', expect.stringContaining('Win32_BIOS'),
    ]);
  });

  it('drops a serial longer than 128 bytes', () => {
    const tooLong = `${'A'.repeat(127)}你`;
    expect(Buffer.byteLength(tooLong)).toBeGreaterThan(128);
    expect(collectHostAsset('win32', unread, () => tooLong)).toBe('');
    expect(collectHostAsset('win32', unread, () => `${tooLong}\nPF2ABCDE`)).toBe('PF2ABCDE');
    expect(collectHostAsset('linux', () => tooLong, notExecuted)).toBe('');
  });

  it('drops the listed placeholders', () => {
    for (const raw of ['None', 'Default string', 'System Serial Number', 'Not Specified', '0', '  ']) {
      expect(collectHostAsset('win32', unread, () => raw)).toBe('');
    }
  });

  it('reads the first usable Linux DMI file and skips unreadable or placeholder files', () => {
    const readFile = vi.fn((path: string) => {
      if (path.endsWith('product_serial')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      if (path.endsWith('board_serial')) return 'None\n';
      if (path.endsWith('chassis_serial')) return 'BOARD-1\n';
      throw new Error(`unexpected ${path}`);
    });
    const execFile = vi.fn(() => 'should-not-run');
    expect(collectHostAsset('linux', readFile, execFile)).toBe('BOARD-1');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('returns an empty serial and does not throw when the command fails', () => {
    const execFile = vi.fn(() => { throw new Error('timeout'); });
    expect(collectHostAsset('darwin', unread, execFile)).toBe('');
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('returns an empty serial when every Linux file is unreadable', () => {
    const readFile = vi.fn(() => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });
    expect(collectHostAsset('linux', readFile, notExecuted)).toBe('');
    expect(readFile).toHaveBeenCalledTimes(3);
  });
});
