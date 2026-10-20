import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { commandExists, detectAgent } from '../../../src/deployment/detect-utils.js';

describe('detectAgent — glob path support', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'detect-glob-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('matches a single-segment * wildcard', async () => {
    const target = path.join(tmpDir, 'IntelliJIdea2026.1', 'plugins', 'qoder-jetbrains');
    await fs.mkdir(target, { recursive: true });
    const pattern = path.join(tmpDir, 'IntelliJIdea*', 'plugins', 'qoder-jetbrains');

    const ok = await detectAgent({ paths: [pattern], commands: [] });
    expect(ok).toBe(true);
  });

  it('returns false when no glob match exists', async () => {
    await fs.mkdir(path.join(tmpDir, 'Other2026'), { recursive: true });
    const pattern = path.join(tmpDir, 'IntelliJIdea*', 'plugins', 'qoder-jetbrains');

    const ok = await detectAgent({ paths: [pattern], commands: [] });
    expect(ok).toBe(false);
  });

  it('mixes glob and literal paths in the same detection list', async () => {
    const literal = path.join(tmpDir, 'literal-marker');
    await fs.writeFile(literal, '');
    const pattern = path.join(tmpDir, 'never-matches-*', 'qoder-jetbrains');

    const ok = await detectAgent({ paths: [pattern, literal], commands: [] });
    expect(ok).toBe(true);
  });

  it('handles ? single-character wildcard', async () => {
    await fs.mkdir(path.join(tmpDir, 'PyCharm2026'), { recursive: true });
    const pattern = path.join(tmpDir, 'PyCharm202?');

    const ok = await detectAgent({ paths: [pattern], commands: [] });
    expect(ok).toBe(true);
  });

  it('does not match ? against multiple characters', async () => {
    await fs.mkdir(path.join(tmpDir, 'PyCharm2026'), { recursive: true });
    const pattern = path.join(tmpDir, 'PyCharm20?');

    const ok = await detectAgent({ paths: [pattern], commands: [] });
    expect(ok).toBe(false);
  });
});

describe('commandExists — bounded cache and fresh lookup', () => {
  it.skipIf(process.platform === 'win32')('keeps the normal cache, but sees installation and removal when fresh is requested', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'detect-command-'));
    const command = `pilot-detect-${path.basename(tmpDir)}`;
    const executable = path.join(tmpDir, command);
    const previousPath = process.env.PATH;
    process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
    try {
      expect(await commandExists(command)).toBe(false);
      await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      expect(await commandExists(command)).toBe(false);
      expect(await commandExists(command, { fresh: true })).toBe(true);
      expect(await commandExists(command)).toBe(true);
      expect(await commandExists(executable)).toBe(true);
      await fs.rm(executable);
      expect(await commandExists(command)).toBe(true);
      expect(await commandExists(command, { fresh: true })).toBe(false);
      expect(await commandExists(executable)).toBe(false);
      await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      process.env.PATH = `${tmpDir}${path.delimiter}${process.env.PATH}`;
      expect(await commandExists(command)).toBe(true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('refreshes an ordinary cached answer after 60 seconds', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'detect-cache-'));
    const command = `pilot-cache-${path.basename(tmpDir)}`;
    const previousPath = process.env.PATH;
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
    try {
      expect(await commandExists(command)).toBe(false);
      await fs.writeFile(path.join(tmpDir, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      expect(await commandExists(command)).toBe(false);
      clock.mockReturnValue(now + 60_001);
      expect(await commandExists(command)).toBe(true);
    } finally {
      clock.mockRestore();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
