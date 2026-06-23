import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { detectAgent } from '../../../src/deployment/detect-utils.js';

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
