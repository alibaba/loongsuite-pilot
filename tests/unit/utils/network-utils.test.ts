import { afterEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { LOCAL_IP, refreshLocalIp, resolveLocalIp } from '../../../src/utils/network-utils.js';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    networkInterfaces: vi.fn(actual.networkInterfaces),
  };
});

function nic(address: string, internal = false): os.NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: null };
}

const execFileSyncMock = vi.mocked(execFileSync);

describe('resolveLocalIp', () => {
  afterEach(() => {
    process.env.VITEST = 'true';
    execFileSyncMock.mockReset();
    vi.mocked(os.networkInterfaces).mockReset();
  });

  it('does not probe while tests are importing the module', () => {
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('uses the direct egress address and ignores the local NIC', () => {
    delete process.env.VITEST;
    execFileSyncMock.mockReturnValue('203.0.113.10\n' as never);
    vi.mocked(os.networkInterfaces).mockReturnValue({
      en0: [nic('192.0.2.10')],
    });
    expect(resolveLocalIp()).toBe('203.0.113.10');
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'curl',
      expect.arrayContaining(['-4', '--noproxy', '*', 'https://ifconfig.me/ip']),
      expect.objectContaining({
        timeout: 3000,
        env: expect.objectContaining({
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
        }),
      }),
    );
  });

  it('falls back to the first non-internal IPv4 when the probe is not an address', () => {
    delete process.env.VITEST;
    execFileSyncMock.mockReturnValue('not-an-ip\n' as never);
    vi.mocked(os.networkInterfaces).mockReturnValue({
      'vEthernet (WSL)': [nic('198.51.100.1')],
      Ethernet: [nic('198.51.100.20')],
    });
    expect(resolveLocalIp()).toBe('198.51.100.1');
  });

  it('falls back to the first non-internal IPv4 when the probe is not a valid address', () => {
    delete process.env.VITEST;
    execFileSyncMock.mockReturnValue('999.999.999.999\n' as never);
    vi.mocked(os.networkInterfaces).mockReturnValue({
      en0: [nic('192.0.2.20')],
    });
    expect(resolveLocalIp()).toBe('192.0.2.20');
  });

  it('falls back to the first non-internal IPv4 when the probe fails', () => {
    delete process.env.VITEST;
    execFileSyncMock.mockImplementation(() => { throw new Error('curl failed'); });
    vi.mocked(os.networkInterfaces).mockReturnValue({
      lo0: [nic('127.0.0.1', true)],
      en0: [nic('192.0.2.30')],
    });
    expect(resolveLocalIp()).toBe('192.0.2.30');
  });
});

describe('refreshLocalIp', () => {
  afterEach(() => {
    process.env.VITEST = 'true';
    execFileSyncMock.mockReset();
    vi.mocked(os.networkInterfaces).mockReset();
  });

  it('replaces the recorded address when the next probe returns a new one', () => {
    delete process.env.VITEST;
    execFileSyncMock.mockReturnValue('203.0.113.10\n' as never);
    refreshLocalIp();
    expect(LOCAL_IP).toBe('203.0.113.10');

    execFileSyncMock.mockReturnValue('203.0.113.20\n' as never);
    refreshLocalIp();
    expect(LOCAL_IP).toBe('203.0.113.20');
  });

  it('falls back to the first non-internal IPv4 when the probe fails', () => {
    delete process.env.VITEST;
    execFileSyncMock.mockReturnValue('203.0.113.10\n' as never);
    refreshLocalIp();

    execFileSyncMock.mockImplementation(() => { throw new Error('curl failed'); });
    vi.mocked(os.networkInterfaces).mockReturnValue({
      en0: [nic('192.0.2.30')],
    });
    refreshLocalIp();
    expect(LOCAL_IP).toBe('192.0.2.30');
  });
});
