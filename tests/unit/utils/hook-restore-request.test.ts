import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDir, cleanupTempDir } from '../../helpers/fixture-builder.js';
import { getUpgradeMarkerPath, hookUpgradeInProgress, installedVersionDir } from '../../../src/utils/hook-restore-request.js';

describe('hook upgrade marker', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(dir);
  });

  it('expires an interrupted marker write based on its modification time', async () => {
    const marker = getUpgradeMarkerPath(dir);
    await fs.writeFile(marker, '');
    expect(await hookUpgradeInProgress(dir)).toBe(true);
    const past = new Date(Date.now() - 11 * 60_000);
    await fs.utimes(marker, past, past);
    expect(await hookUpgradeInProgress(dir)).toBe(false);
  });
});

describe('installedVersionDir', () => {
  it('returns the version directory that contains this module', () => {
    const modulePath = path.join('/cache/versions/1.2.3_abc', 'dist', 'updater', 'hook-asset-repair.js');
    expect(installedVersionDir(pathToFileURL(modulePath).href)).toBe(path.join('/cache/versions/1.2.3_abc'));
  });

  it('returns null when the module is not inside versions', () => {
    const modulePath = path.join('/repo/src/updater', 'hook-asset-repair.ts');
    expect(installedVersionDir(pathToFileURL(modulePath).href)).toBeNull();
  });
});
