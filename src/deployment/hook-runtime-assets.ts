import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeTextFileAtomic } from '../utils/fs-utils.js';

async function sameFile(source: string, target: string): Promise<boolean> {
  try {
    const [sourceBytes, targetBytes] = await Promise.all([
      fs.readFile(source),
      fs.readFile(target),
    ]);
    if (!sourceBytes.equals(targetBytes)) return false;
    if (process.platform !== 'win32' && source.endsWith('.sh')) {
      const stat = await fs.stat(target);
      return (stat.mode & 0o111) !== 0;
    }
    return true;
  } catch {
    return false;
  }
}

export async function areHookRuntimeAssetsHealthy(
  pilotDir: string,
  dataDir: string,
  assets: readonly string[],
): Promise<boolean> {
  const sourceRoot = path.join(pilotDir, 'assets', 'hooks');
  const targetRoot = path.join(dataDir, 'hooks');
  const results = await Promise.all(assets.map(relativePath =>
    sameFile(path.join(sourceRoot, relativePath), path.join(targetRoot, relativePath))));
  return results.every(Boolean);
}

export async function restoreHookRuntimeAssets(
  pilotDir: string,
  dataDir: string,
  assets: readonly string[],
  verifyPaths?: (source: string, target: string) => Promise<void>,
): Promise<void> {
  const sourceRoot = path.join(pilotDir, 'assets', 'hooks');
  const targetRoot = path.join(dataDir, 'hooks');

  for (const relativePath of assets) {
    const source = path.join(sourceRoot, relativePath);
    const target = path.join(targetRoot, relativePath);
    if (verifyPaths) await verifyPaths(source, target);
    await fs.access(source);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const content = await fs.readFile(source, 'utf8');
    if (verifyPaths) {
      await verifyPaths(source, target);
      await writeTextFileAtomic(target, content, {
        mode: relativePath.endsWith('.sh') ? 0o755 : 0o644,
        preserveMode: true,
      });
      continue;
    }
    await writeTextFileAtomic(target, content);
    await fs.chmod(target, relativePath.endsWith('.sh') ? 0o755 : 0o644).catch(() => {});
  }
}
