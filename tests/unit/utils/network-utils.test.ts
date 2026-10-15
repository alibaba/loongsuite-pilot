import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { execFile, type ExecFileException } from 'node:child_process';

const held = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  actualInterfaces: undefined as undefined | typeof import('node:os').networkInterfaces,
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: held.info,
    warn: held.warn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  held.actualInterfaces = actual.networkInterfaces;
  return {
    ...actual,
    networkInterfaces: vi.fn((...args: Parameters<typeof actual.networkInterfaces>) => actual.networkInterfaces(...args)),
  };
});

function nic(address: string, internal = false): os.NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: null };
}

type CurlCallback = (err: ExecFileException | null, stdout?: string, stderr?: string) => void;

const execFileMock = vi.mocked(execFile);

function curlStdout(stdout: string): void {
  execFileMock.mockImplementation(((...args: unknown[]) => {
    const cb = args.at(-1) as CurlCallback;
    cb(null, stdout, '');
  }) as never);
}

function curlError(err: ExecFileException & { stderr?: string }): void {
  execFileMock.mockImplementation(((...args: unknown[]) => {
    const cb = args.at(-1) as CurlCallback;
    cb(err);
  }) as never);
}

async function load() {
  return import('../../../src/utils/network-utils.js');
}

describe('local ip', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.VITEST = 'true';
    held.info.mockClear();
    held.warn.mockClear();
    execFileMock.mockReset();
    vi.mocked(os.networkInterfaces).mockReset();
    vi.mocked(os.networkInterfaces).mockImplementation(() => held.actualInterfaces!());
  });

  it('does not probe while the module is imported', async () => {
    await load();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('resolveLocalIp returns the first non-internal IPv4 without probing', async () => {
    delete process.env.VITEST;
    vi.mocked(os.networkInterfaces).mockReturnValue({
      'vEthernet (WSL)': [nic('198.51.100.1')],
      Ethernet: [nic('198.51.100.20')],
    });
    const { resolveLocalIp } = await load();
    expect(resolveLocalIp()).toBe('198.51.100.1');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('records a probed address and replaces it when the next probe changes', async () => {
    delete process.env.VITEST;
    const net = await load();
    curlStdout('203.0.113.10\n');
    await net.refreshLocalIp();
    expect(net.LOCAL_IP).toBe('203.0.113.10');
    expect(execFileMock).toHaveBeenCalledWith(
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
      expect.any(Function),
    );

    curlStdout('203.0.113.20\n');
    await net.refreshLocalIp();
    expect(net.LOCAL_IP).toBe('203.0.113.20');
    expect(held.info).toHaveBeenCalledTimes(1);
  });

  it('keeps the last egress address when a later probe fails', async () => {
    delete process.env.VITEST;
    const net = await load();
    curlStdout('203.0.113.10\n');
    await net.refreshLocalIp();

    const timedOut = 'curl: (28) Connection timed out after 1006 milliseconds';
    curlError(Object.assign(new Error('Command failed: curl'), { code: 28, stderr: timedOut }));
    await net.refreshLocalIp();
    expect(net.LOCAL_IP).toBe('203.0.113.10');
    expect(held.warn).toHaveBeenCalledTimes(1);
    expect(held.warn).toHaveBeenCalledWith('direct egress lookup failed', {
      code: 28,
      error: timedOut,
    });

    curlError(Object.assign(new Error('Command failed: curl'), {
      code: 28,
      stderr: 'curl: (28) Connection timed out after 3002 milliseconds',
    }));
    await net.refreshLocalIp();
    expect(held.warn).toHaveBeenCalledTimes(1);

    await net.refreshLocalIp();
    expect(held.warn).toHaveBeenCalledTimes(1);

    curlStdout('not-an-ip\n');
    await net.refreshLocalIp();
    expect(net.LOCAL_IP).toBe('203.0.113.10');
    expect(held.warn).toHaveBeenCalledWith('direct egress lookup failed', {
      error: 'response is not an IPv4 address: not-an-ip',
    });

    curlStdout('203.0.113.30\n');
    await net.refreshLocalIp();
    expect(net.LOCAL_IP).toBe('203.0.113.30');
    expect(held.info).toHaveBeenCalledWith('direct egress lookup succeeded');
  });

  it('uses the interface address only before the first successful probe', async () => {
    delete process.env.VITEST;
    vi.mocked(os.networkInterfaces).mockReturnValue({
      lo0: [nic('127.0.0.1', true)],
      en0: [nic('192.0.2.30')],
    });
    const net = await load();
    curlError(Object.assign(new Error('curl missing'), { code: 'ENOENT' }));
    await net.refreshLocalIp();
    expect(net.LOCAL_IP).toBe('192.0.2.30');
    expect(held.warn).toHaveBeenCalledWith('direct egress lookup failed', {
      code: 'ENOENT',
      error: 'Error: curl missing',
    });
  });

  it('shares one in-flight probe', async () => {
    delete process.env.VITEST;
    const net = await load();
    let finish: CurlCallback = () => {};
    execFileMock.mockImplementation(((...args: unknown[]) => {
      finish = args.at(-1) as CurlCallback;
    }) as never);
    const first = net.refreshLocalIp();
    const second = net.refreshLocalIp();
    expect(execFileMock).toHaveBeenCalledTimes(1);
    finish(null, '203.0.113.10\n', '');
    await first;
    await second;
    expect(net.LOCAL_IP).toBe('203.0.113.10');
  });
});
