import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_E2E_INSTALL_SLS_ENDPOINT,
  normalizeSlsEndpoint,
  shellSingleQuoteBash,
  shouldPropagateSlsToRemoteInstall,
  buildRemoteInstallSlsCliQuotedArgs,
} from '../../scripts/e2e/lib/propagate-sls-install.mjs';

describe('propagate-sls-install', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('normalizeSlsEndpoint adds https when missing', () => {
    expect(normalizeSlsEndpoint('cn-hangzhou.log.aliyuncs.com')).toBe(
      'https://cn-hangzhou.log.aliyuncs.com',
    );
    expect(normalizeSlsEndpoint('https://cn-hangzhou.log.aliyuncs.com')).toBe(
      'https://cn-hangzhou.log.aliyuncs.com',
    );
  });

  it('shellSingleQuoteBash escapes single quotes', () => {
    expect(shellSingleQuoteBash("a'b")).toBe(`'a'\\''b'`);
  });

  it('does not propagate when E2E_PROPAGATE_SLS_INSTALL=0', () => {
    vi.stubEnv('E2E_PROPAGATE_SLS_INSTALL', '0');
    vi.stubEnv('E2E_SLS_PROJECT', 'p');
    vi.stubEnv('E2E_SLS_LOGSTORE', 'l');
    expect(shouldPropagateSlsToRemoteInstall(process.env)).toBe(false);
    expect(buildRemoteInstallSlsCliQuotedArgs(process.env)).toBe('');
  });

  it('propagates endpoint project logstore with Hangzhou default when endpoint unset', () => {
    vi.stubEnv('E2E_SLS_PROJECT', 'my-proj');
    vi.stubEnv('E2E_SLS_LOGSTORE', 'my-store');
    expect(shouldPropagateSlsToRemoteInstall(process.env)).toBe(true);
    const s = buildRemoteInstallSlsCliQuotedArgs(process.env);
    expect(s).toContain(`--sls-endpoint '${DEFAULT_E2E_INSTALL_SLS_ENDPOINT}'`);
    expect(s).toContain(`--sls-project 'my-proj'`);
    expect(s).toContain(`--sls-logstore 'my-store'`);
    expect(s).not.toContain('--sls-ak-id');
  });

  it('uses E2E_SLS_ENDPOINT when set (adds https)', () => {
    vi.stubEnv('E2E_SLS_PROJECT', 'p');
    vi.stubEnv('E2E_SLS_LOGSTORE', 'l');
    vi.stubEnv('E2E_SLS_ENDPOINT', 'cn-shanghai.log.aliyuncs.com');
    const s = buildRemoteInstallSlsCliQuotedArgs(process.env);
    expect(s).toContain(`--sls-endpoint 'https://cn-shanghai.log.aliyuncs.com'`);
  });

  it('adds AK flags when both key vars set', () => {
    vi.stubEnv('E2E_SLS_PROJECT', 'p');
    vi.stubEnv('E2E_SLS_LOGSTORE', 'l');
    vi.stubEnv('E2E_SLS_ACCESS_KEY_ID', 'LTAIxxxxxxxxxxxx');
    vi.stubEnv('E2E_SLS_ACCESS_KEY_SECRET', 'secretvalue');
    const s = buildRemoteInstallSlsCliQuotedArgs(process.env);
    expect(s).toContain(`--sls-ak-id 'LTAIxxxxxxxxxxxx'`);
    expect(s).toContain(`--sls-ak-secret 'secretvalue'`);
  });
});
