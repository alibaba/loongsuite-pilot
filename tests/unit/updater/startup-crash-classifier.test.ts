import { describe, it, expect } from 'vitest';
import { classifyStartupCrash } from '../../../src/updater/startup-crash-classifier.js';
import type { StartupCrashBreadcrumb, StartupCrashPhase } from '../../../src/utils/crash-breadcrumb.js';

function bc(
  error_message: string,
  opts: { phase?: StartupCrashPhase; stack?: string } = {},
): StartupCrashBreadcrumb {
  return {
    schema: 1,
    ts: 0,
    phase: opts.phase ?? 'module_load',
    version: '1.0.0',
    pid: 1,
    error_message,
    error_stack_head: opts.stack ?? '',
  };
}

describe('classifyStartupCrash', () => {
  it('maps sqlite3 / native addon failures to native_module_missing', () => {
    expect(classifyStartupCrash(bc('Error: Cannot open sqlite3 binding')).reason).toBe('native_module_missing');
    expect(classifyStartupCrash(bc('ERR_DLOPEN_FAILED: dlopen failed')).reason).toBe('native_module_missing');
    expect(classifyStartupCrash(bc("Module did not self-register")).reason).toBe('native_module_missing');
    expect(classifyStartupCrash(bc("Cannot find module '/x/build/Release/node_sqlite3.node'")).reason).toBe('native_module_missing');
    expect(classifyStartupCrash(bc('The module was compiled against a different Node.js version using NODE_MODULE_VERSION 108')).reason).toBe('native_module_missing');
    expect(classifyStartupCrash(bc('npm error install scripts were not run')).reason).toBe('native_module_missing');
  });

  it('maps a plain missing module to module_not_found', () => {
    expect(classifyStartupCrash(bc("Cannot find module 'lodash'")).reason).toBe('module_not_found');
  });

  it('maps startup-phase config/JSON errors to config_error', () => {
    expect(classifyStartupCrash(bc('Unexpected token } in JSON at position 5', { phase: 'startup' })).reason).toBe('config_error');
    expect(classifyStartupCrash(bc('failed to parse config file', { phase: 'startup' })).reason).toBe('config_error');
  });

  it('does not treat JSON errors as config_error outside startup phase', () => {
    expect(classifyStartupCrash(bc('Unexpected token in JSON', { phase: 'module_load' })).reason).toBe('unknown');
  });

  it('maps permission / disk errors', () => {
    expect(classifyStartupCrash(bc('EACCES: permission denied')).reason).toBe('permission_or_disk');
    expect(classifyStartupCrash(bc('ENOSPC: no space left on device')).reason).toBe('permission_or_disk');
  });

  it('falls back to unknown and carries the raw message head', () => {
    const res = classifyStartupCrash(bc('some totally novel failure\nsecond line'));
    expect(res.reason).toBe('unknown');
    expect(res.detailHead).toBe('some totally novel failure');
  });
});
