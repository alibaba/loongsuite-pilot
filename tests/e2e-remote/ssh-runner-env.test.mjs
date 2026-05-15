import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isSshInteractivePasswordEnv,
  buildSshArgs,
  REMOTE_SCRIPT_VIA_BASE64,
  resolveSshIdentity,
} from '../../scripts/e2e/lib/ssh-runner.mjs';

describe('ssh-runner interactive password env', () => {
  beforeEach(() => {
    vi.stubEnv('E2E_SSH_PASSWORD_AUTH', '');
    vi.stubEnv('E2E_SSH_BATCH_MODE', '');
    vi.stubEnv('E2E_SSH_EXTRA_OPTS', '');
    vi.stubEnv('E2E_SSH_REMOTE_TTY', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to batch (non-interactive) ssh', () => {
    expect(isSshInteractivePasswordEnv()).toBe(false);
    const args = buildSshArgs('u@h', undefined, false);
    expect(args).toContain('-o');
    expect(args).toContain('BatchMode=yes');
    expect(args).not.toContain('-tt');
    expect(args.at(-2)).toBe('bash');
    expect(args.at(-1)).toBe('-s');
  });

  it('enables interactive flow via E2E_SSH_PASSWORD_AUTH', () => {
    vi.stubEnv('E2E_SSH_PASSWORD_AUTH', '1');
    expect(isSshInteractivePasswordEnv()).toBe(true);
    const args = buildSshArgs('u@h', undefined, true);
    expect(args).not.toContain('-tt');
    expect(args.join(' ')).not.toContain('BatchMode=yes');
    expect(args.at(-1)).toBe(REMOTE_SCRIPT_VIA_BASE64);
  });

  it('adds -tt when E2E_SSH_REMOTE_TTY=1', () => {
    vi.stubEnv('E2E_SSH_PASSWORD_AUTH', '1');
    vi.stubEnv('E2E_SSH_REMOTE_TTY', '1');
    const args = buildSshArgs('u@h', undefined, true);
    expect(args[0]).toBe('-tt');
  });

  it('enables interactive flow via E2E_SSH_BATCH_MODE=0', () => {
    vi.stubEnv('E2E_SSH_BATCH_MODE', 'no');
    expect(isSshInteractivePasswordEnv()).toBe(true);
  });

  it('resolveSshIdentity drops missing paths', () => {
    expect(resolveSshIdentity(undefined)).toBeUndefined();
    expect(resolveSshIdentity('/nonexistent/ssh-key-999999')).toBeUndefined();
  });

  it('prepends E2E_SSH_EXTRA_OPTS', () => {
    vi.stubEnv('E2E_SSH_EXTRA_OPTS', '-o ConnectTimeout=9');
    const args = buildSshArgs('u@h', undefined, false);
    expect(args.slice(0, 3)).toEqual(['-o', 'ConnectTimeout=9', '-o']);
  });
});
