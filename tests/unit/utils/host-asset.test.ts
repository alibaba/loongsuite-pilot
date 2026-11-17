import { describe, expect, it } from 'vitest';
import { selectPrimaryIpv4 } from '../../../src/utils/network-utils.js';
import type * as os from 'node:os';

function ipv4(address: string, mac: string, internal = false): os.NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.0', family: 'IPv4', mac, internal, cidr: null };
}

function ipv6(address: string, mac: string): os.NetworkInterfaceInfo {
  return { address, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac, internal: false, cidr: null, scopeid: 0 };
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
