import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sh = readFileSync('deploy/installer-opensource.sh', 'utf8');
const ps1 = readFileSync('deploy/installer-opensource.ps1', 'utf8');
const fnStart = sh.indexOf('normalize_host_sn()');
const fnEnd = sh.indexOf('\n    read_host_sn()');
const fns = sh.slice(fnStart, fnEnd);

function normalize(raw: string): string {
  const result = spawnSync('bash', ['-c', `set -euo pipefail\n${fns}\nnormalize_host_sn "$1"`, 'normalize', raw], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe('installer host serial', () => {
  it('keeps a macOS serial and drops one longer than 128 characters', () => {
    expect(normalize('C02XG0AHJG5H')).toBe('C02XG0AHJG5H');
    expect(normalize('A'.repeat(128))).toBe('A'.repeat(128));
    expect(normalize(`${'A'.repeat(128)}B`)).toBe('');
  });

  it('drops placeholders and values over 128 bytes', () => {
    for (const raw of ['None', 'Default string', 'System Serial Number', 'Not Specified', '0', '  ', 'To Be Filled By O.E.M.']) {
      expect(normalize(raw)).toBe('');
    }
    const tooLong = `${'A'.repeat(127)}你`;
    expect(Buffer.byteLength(tooLong)).toBeGreaterThan(128);
    expect(normalize(tooLong)).toBe('');
  });

  it('reads the serial from the installer scripts without a helper file', () => {
    expect(sh).not.toContain('host-identity.cjs');
    expect(sh).toContain('ioreg -rd1 -c IOPlatformExpertDevice');
    expect(sh).toContain('/sys/class/dmi/id/product_serial');
    expect(sh).toContain('/sys/class/dmi/id/board_serial');
    expect(sh).toContain('/sys/class/dmi/id/chassis_serial');
    expect(sh).toContain('if (hostSn) config.hostSn = hostSn;');
    expect(sh).not.toContain('config.hostMac');
    expect(ps1).not.toContain('host-identity.cjs');
    expect(ps1).toContain('Win32_BIOS');
    expect(ps1).toContain('Win32_ComputerSystemProduct');
    expect(ps1).toContain('if (opts.hostSn) config.hostSn = opts.hostSn;');
    expect(ps1).not.toContain('config.hostMac');
  });
});
