import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

vi.mock('../../../src/core/build-constants.js', () => ({
  PROPRIETARY_BUILD: false,
}));

import { Orchestrator } from '../../../src/core/orchestrator.js';

type PilotDirResolver = {
  resolvePilotDir: (moduleUrl?: string) => string;
};

describe('Orchestrator.resolvePilotDir', () => {
  let tmpDir: string;
  let dataDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-pilot-dir-'));
    dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function resolvePilotDir(moduleUrl?: string): string {
    const orchestrator = new Orchestrator({ dataDir } as never);
    return (orchestrator as unknown as PilotDirResolver).resolvePilotDir(moduleUrl);
  }

  function createModulePackage(layout: 'src' | 'dist' | 'bundle' = 'src'): {
    packageDir: string;
    moduleUrl: string;
  } {
    const packageDir = path.join(tmpDir, `module-package-${layout}`);
    fs.mkdirSync(path.join(packageDir, 'agents.d'), { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), '{}');
    const modulePath = layout === 'bundle'
      ? path.join(packageDir, 'dist', 'index.js')
      : path.join(
        packageDir,
        layout,
        'core',
        layout === 'src' ? 'orchestrator.ts' : 'orchestrator.js',
      );
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, '');
    return { packageDir, moduleUrl: pathToFileURL(modulePath).href };
  }

  it('keeps the current pointer ahead of legacy and module package roots', () => {
    const currentDir = path.join(dataDir, 'versions', 'v2');
    fs.mkdirSync(currentDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'current'), 'v2\n');

    const legacyDir = path.join(dataDir, 'package');
    fs.mkdirSync(path.join(legacyDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'dist', 'index.js'), '');

    const { moduleUrl } = createModulePackage();
    expect(resolvePilotDir(moduleUrl)).toBe(currentDir);
  });

  it('keeps the legacy package ahead of the module package root', () => {
    const legacyDir = path.join(dataDir, 'package');
    fs.mkdirSync(path.join(legacyDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'dist', 'index.js'), '');

    const { moduleUrl } = createModulePackage();
    expect(resolvePilotDir(moduleUrl)).toBe(legacyDir);
  });

  it.each(['src', 'dist', 'bundle'] as const)(
    'resolves the package root from a %s module URL',
    layout => {
      const { packageDir, moduleUrl } = createModulePackage(layout);
      expect(resolvePilotDir(moduleUrl)).toBe(packageDir);
    },
  );

  it('derives the source package root from import.meta.url by default', () => {
    const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    expect(resolvePilotDir()).toBe(packageDir);
  });

  it.each(['package.json', 'agents.d'] as const)(
    'falls back to dataDir when the module package root lacks %s',
    missingMarker => {
      const { packageDir, moduleUrl } = createModulePackage();
      fs.rmSync(path.join(packageDir, missingMarker), { recursive: true, force: true });

      expect(resolvePilotDir(moduleUrl)).toBe(dataDir);
    },
  );
});
