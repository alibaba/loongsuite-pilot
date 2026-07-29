import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  writeStartupCrash,
  clearStartupCrash,
  readStartupCrash,
  startupCrashPath,
} from '../../../src/utils/crash-breadcrumb.js';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-crash-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('crash-breadcrumb', () => {
  it('writes a breadcrumb from an Error and reads it back', () => {
    writeStartupCrash({
      dataDir,
      phase: 'module_load',
      version: '1.2.3',
      error: new Error('Cannot open sqlite3 .node'),
    });

    expect(fs.existsSync(startupCrashPath(dataDir))).toBe(true);
    const bc = readStartupCrash(dataDir);
    expect(bc).not.toBeNull();
    expect(bc!.schema).toBe(1);
    expect(bc!.phase).toBe('module_load');
    expect(bc!.version).toBe('1.2.3');
    expect(bc!.error_message).toBe('Cannot open sqlite3 .node');
    expect(bc!.error_stack_head).toContain('Error: Cannot open sqlite3 .node');
    expect(typeof bc!.ts).toBe('number');
    expect(bc!.pid).toBe(process.pid);
  });

  it('accepts a non-Error value and empties the stack head', () => {
    writeStartupCrash({ dataDir, phase: 'startup', version: '', error: 'boom' });
    const bc = readStartupCrash(dataDir);
    expect(bc!.error_message).toBe('boom');
    expect(bc!.error_stack_head).toBe('');
    expect(bc!.version).toBe('unknown');
  });

  it('clears the breadcrumb and tolerates a missing file', () => {
    writeStartupCrash({ dataDir, phase: 'startup', version: '1', error: new Error('x') });
    clearStartupCrash(dataDir);
    expect(readStartupCrash(dataDir)).toBeNull();
    // second clear on an absent file must not throw
    expect(() => clearStartupCrash(dataDir)).not.toThrow();
  });

  it('returns null when no breadcrumb exists', () => {
    expect(readStartupCrash(dataDir)).toBeNull();
  });

  it('is best-effort and never throws on an unwritable data dir', () => {
    // point at a path whose parent is a file, so mkdir/write fail internally
    const fileAsDir = path.join(dataDir, 'not-a-dir');
    fs.writeFileSync(fileAsDir, 'x');
    expect(() =>
      writeStartupCrash({ dataDir: fileAsDir, phase: 'runtime', version: '1', error: new Error('y') }),
    ).not.toThrow();
  });
});
