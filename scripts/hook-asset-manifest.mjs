import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** SHA-256 of each regular file under assets/hooks, keyed by relative path. */
export async function collectHookAssetManifest(root) {
  /** @type {Record<string, string>} */
  const manifest = {};

  async function walk(dir, relative) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('._') || entry.name === '.DS_Store') continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        const bytes = await readFile(path.join(dir, entry.name));
        manifest[rel] = createHash('sha256').update(bytes).digest('hex');
      }
    }
  }

  await walk(root, '');
  return Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
}
