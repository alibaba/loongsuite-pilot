import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { cleanupDshIntegration } from '../../../assets/plugins/dsh/cleanup.mjs';

const MARKER = 'PILOT-OBSERVABILITY-MANAGED';

function block(createdFile) {
  return [
    `# BEGIN ${MARKER} (created-file: ${createdFile})`,
    '# entryId=loongsuite-pilot-observability',
    '# pluginSource=file:///pilot/plugins/dsh/plugin.mjs',
    '# pluginHash=abc123',
    '- insert:',
    "  - id: 'loongsuite-pilot-observability'",
    '    name: file:///pilot/plugins/dsh/plugin.mjs',
    `# END ${MARKER}`,
    '',
  ].join('\n');
}

describe('DSH uninstall cleanup helper', () => {
  let tmpDir;
  let patchPath;
  let pluginDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cleanup-'));
    patchPath = path.join(tmpDir, 'dsh-home', 'cordis.patch.yml');
    pluginDir = path.join(tmpDir, 'pilot-data', 'plugins', 'dsh');
    await fs.mkdir(path.dirname(patchPath), { recursive: true });
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, '.collection-enabled'), 'enabled\n');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('removes only the Pilot block and preserves third-party bytes verbatim', async () => {
    const before = '# user-before\n- id: user-a\n  name: file:///a\n';
    const after = '# user-after\r\n- id: user-b\r\n  name: file:///b\r\n';
    await fs.writeFile(patchPath, before + block(false) + after);

    const result = await cleanupDshIntegration({ patchPath, pluginDir, marker: MARKER });
    expect(result).toMatchObject({ success: true, changed: true });
    expect(await fs.readFile(patchPath, 'utf-8')).toBe(before + after);
    await expect(fs.stat(path.join(pluginDir, '.collection-enabled')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('deletes an otherwise empty patch file created by Pilot', async () => {
    await fs.writeFile(patchPath, block(true));
    const result = await cleanupDshIntegration({ patchPath, pluginDir, marker: MARKER });
    expect(result.success).toBe(true);
    await expect(fs.stat(patchPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not create a DSH home when the patch file is already absent', async () => {
    const missingHome = path.join(tmpDir, 'missing-dsh-home');
    const missingPatch = path.join(missingHome, 'cordis.patch.yml');

    const result = await cleanupDshIntegration({
      patchPath: missingPatch,
      pluginDir,
      marker: MARKER,
    });

    expect(result).toEqual({ success: true, changed: false });
    await expect(fs.stat(missingHome)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(pluginDir, '.collection-enabled')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed and preserves an incomplete marker block', async () => {
    const invalid = `# BEGIN ${MARKER}\n- insert: []\n`;
    await fs.writeFile(patchPath, invalid);
    const result = await cleanupDshIntegration({ patchPath, pluginDir, marker: MARKER });
    expect(result.success).toBe(false);
    expect(await fs.readFile(patchPath, 'utf-8')).toBe(invalid);
  });

  it.each([
    ['unmatched END', `user-before\n# END ${MARKER}\nuser-after\n`],
    ['nested BEGIN', `# BEGIN ${MARKER}\n# BEGIN ${MARKER}\n${block(false)}`],
    ['duplicate blocks', `${block(false)}${block(false)}`],
  ])('fails closed and preserves malformed marker bytes: %s', async (_label, invalid) => {
    await fs.writeFile(patchPath, invalid);
    const result = await cleanupDshIntegration({ patchPath, pluginDir, marker: MARKER });
    expect(result.success).toBe(false);
    expect(await fs.readFile(patchPath, 'utf-8')).toBe(invalid);
  });

  it('serializes concurrent stale-lock cleanup without corrupting user bytes', async () => {
    const before = '# user-before\n';
    const after = '# user-after\n';
    await fs.writeFile(patchPath, before + block(false) + after);
    const lockPath = `${patchPath}.loongsuite-pilot.lock`;
    await fs.writeFile(lockPath, 'abandoned');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, old, old);

    const [a, b] = await Promise.all([
      cleanupDshIntegration({ patchPath, pluginDir, marker: MARKER }),
      cleanupDshIntegration({ patchPath, pluginDir, marker: MARKER }),
    ]);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(await fs.readFile(patchPath, 'utf-8')).toBe(before + after);
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(`${lockPath}.reclaim`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('wires cleanup before installation asset removal on Unix and Windows', async () => {
    const unix = await fs.readFile(path.resolve('deploy/installer-opensource.sh'), 'utf-8');
    const unixUninstall = unix.slice(unix.indexOf('cmd_uninstall()'));
    expect(unixUninstall.indexOf('remove_dsh_yaml_patch'))
      .toBeLessThan(unixUninstall.indexOf('rm -rf "${_cache_dir:?}/versions"'));

    const windows = await fs.readFile(path.resolve('deploy/installer-opensource.ps1'), 'utf-8');
    const windowsUninstall = windows.slice(windows.indexOf('function Cmd-Uninstall'));
    expect(windowsUninstall.indexOf('Remove-DshYamlPatch'))
      .toBeLessThan(windowsUninstall.indexOf('Remove-PilotInstallationFiles'));
    expect(unix).toContain('dshPatchPath');
    expect(windows).toContain('dshPatchPath');
  });
});
