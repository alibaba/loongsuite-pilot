import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  DSH_ENABLED_MARKER,
  DshYamlPatchStrategy,
} from '../../../src/deployment/dsh-yaml-patch-strategy.js';
import type { AgentDefinition } from '../../../src/types/index.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/deployment/detect-utils.js', () => ({
  detectAgent: vi.fn().mockResolvedValue(true),
}));

const MARKER = 'PILOT-OBSERVABILITY-MANAGED';
const ENTRY_ID = 'loongsuite-pilot-observability';

describe('DshYamlPatchStrategy', () => {
  let tmpDir: string;
  let patchPath: string;
  let pluginPath: string;
  let enabledMarkerPath: string;
  let strategy: DshYamlPatchStrategy;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-yaml-patch-'));
    patchPath = path.join(tmpDir, 'cordis.patch.yml');
    pluginPath = path.join(tmpDir, 'plugin.mjs');
    enabledMarkerPath = path.join(tmpDir, DSH_ENABLED_MARKER);
    await fs.writeFile(pluginPath, 'export default function apply() {}\n');
    strategy = new DshYamlPatchStrategy(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
    return {
      id: 'dsh',
      displayName: 'DeepSeek Harness',
      deployMode: 'dsh-yaml-patch',
      detection: { paths: [], commands: ['dsh'] },
      dshYamlPatch: {
        pluginSource: pluginPath,
        patchPath,
        entryId: ENTRY_ID,
        marker: MARKER,
      },
      ...overrides,
    } as AgentDefinition;
  }

  async function readPatch(): Promise<string> {
    try { return await fs.readFile(patchPath, 'utf-8'); }
    catch { return ''; }
  }

  it('creates a new patch file when none exists (created-file: true)', async () => {
    const def = makeDef();
    const result = await strategy.deploy(def);
    expect(result.success).toBe(true);
    const content = await readPatch();
    expect(content).toContain(`# BEGIN ${MARKER} (created-file: true)`);
    expect(content).toContain(`# entryId=${ENTRY_ID}`);
    expect(content).toContain(`- insert:`);
    expect(content).toContain(`id: 'loongsuite-pilot-observability'`);
    expect(content).toContain(`# END ${MARKER}`);
    expect(await fs.readFile(enabledMarkerPath, 'utf-8')).toBe('enabled\n');
  });

  it('appends to a user-pre-existing non-empty file (created-file: false)', async () => {
    await fs.writeFile(patchPath, '- id: user-other-plugin\n  name: file:///tmp/other.mjs\n');
    const def = makeDef();
    const result = await strategy.deploy(def);
    expect(result.success).toBe(true);
    const content = await readPatch();
    expect(content).toContain('- id: user-other-plugin');
    expect(content).toContain(`# BEGIN ${MARKER} (created-file: false)`);
    expect(content.indexOf('- id: user-other-plugin')).toBeLessThan(content.indexOf(`# BEGIN ${MARKER}`));
  });

  it('preserves user bytes verbatim (no js-yaml.dump whole-file rewrite)', async () => {
    const userBlock = [
      '# user comment line',
      '- id: user-other-plugin',
      '  name: file:///tmp/other.mjs',
      '',
    ].join('\n');
    await fs.writeFile(patchPath, userBlock);
    const def = makeDef();
    await strategy.deploy(def);
    const content = await readPatch();
    expect(content.startsWith('# user comment line\n- id: user-other-plugin\n  name: file:///tmp/other.mjs\n')).toBe(true);
  });

  it('is idempotent on repeated deploy', async () => {
    const def = makeDef();
    await strategy.deploy(def);
    const firstContent = await readPatch();
    await strategy.deploy(def);
    const secondContent = await readPatch();
    expect(secondContent).toBe(firstContent);
    const needs = await strategy.needsDeploy(def);
    expect(needs).toBe(false);
  });

  it('undeploys from a Pilot-created file, deleting it when empty', async () => {
    const def = makeDef();
    await strategy.deploy(def);
    expect(await readPatch()).not.toBe('');
    const ok = await strategy.undeploy(def);
    expect(ok).toBe(true);
    expect(await readPatch()).toBe('');
    await expect(fs.stat(enabledMarkerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('undeploys from a user file, preserving user bytes (created-file: false)', async () => {
    const userBlock = '- id: user-other-plugin\n  name: file:///tmp/other.mjs\n';
    await fs.writeFile(patchPath, userBlock);
    const def = makeDef();
    await strategy.deploy(def);
    const ok = await strategy.undeploy(def);
    expect(ok).toBe(true);
    expect(await readPatch()).toBe(userBlock);
  });

  it('preserves a user pre-existing EMPTY file on undeploy (created-file: false)', async () => {
    await fs.writeFile(patchPath, '');
    const def = makeDef();
    await strategy.deploy(def);
    const contentAfterDeploy = await readPatch();
    expect(contentAfterDeploy.length).toBeGreaterThan(0);
    expect(contentAfterDeploy).toContain('created-file: false');
    const ok = await strategy.undeploy(def);
    expect(ok).toBe(true);
    // user original was empty file → must remain as empty file (not deleted)
    const stat = await fs.stat(patchPath);
    expect(stat.size).toBe(0);
  });

  it('rejects when an existing block reuses the marker but is not Pilot-managed', async () => {
    const hostile = [
      `# BEGIN ${MARKER}`,
      '- id: hostile-takeover',
      '  name: file:///tmp/hostile.mjs',
      `# END ${MARKER}`,
      '',
    ].join('\n');
    await fs.writeFile(patchPath, hostile);
    const def = makeDef();
    const result = await strategy.deploy(def);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/conflict/);
    const content = await readPatch();
    expect(content).toBe(hostile);
  });

  it.each([
    ['unmatched BEGIN', `user-before\n# BEGIN ${MARKER}\nuser-after\n`],
    ['unmatched END', `user-before\n# END ${MARKER}\nuser-after\n`],
    [
      'nested BEGIN',
      [
        'user-before',
        `# BEGIN ${MARKER}`,
        `# BEGIN ${MARKER}`,
        '# entryId=loongsuite-pilot-observability',
        '# pluginSource=file:///pilot/plugin.mjs',
        '# pluginHash=abc',
        `# END ${MARKER}`,
        'user-after',
        '',
      ].join('\n'),
    ],
    [
      'duplicate blocks',
      [
        `# BEGIN ${MARKER}`,
        '# entryId=loongsuite-pilot-observability',
        '# pluginSource=file:///pilot/a.mjs',
        '# pluginHash=abc',
        `# END ${MARKER}`,
        `# BEGIN ${MARKER}`,
        '# entryId=loongsuite-pilot-observability',
        '# pluginSource=file:///pilot/b.mjs',
        '# pluginHash=def',
        `# END ${MARKER}`,
        '',
      ].join('\n'),
    ],
  ])('fails closed without changing bytes for malformed marker shape: %s', async (_label, malformed) => {
    await fs.writeFile(patchPath, malformed);
    const result = await strategy.deploy(makeDef());
    expect(result.success).toBe(false);
    expect(await fs.readFile(patchPath, 'utf-8')).toBe(malformed);

    const removed = await strategy.undeploy(makeDef());
    expect(removed).toBe(false);
    expect(await fs.readFile(patchPath, 'utf-8')).toBe(malformed);
  });

  it('does not touch third-party rows on deploy or undeploy', async () => {
    const thirdParty = [
      '- id: third-party-a',
      '  name: file:///tmp/a.mjs',
      '- id: third-party-b',
      '  name: file:///tmp/b.mjs',
      '',
    ].join('\n');
    await fs.writeFile(patchPath, thirdParty);
    const def = makeDef();
    await strategy.deploy(def);
    await strategy.undeploy(def);
    const content = await readPatch();
    expect(content.trim()).toBe(thirdParty.trim());
  });

  it('redeploys when plugin file content changes (hash mismatch)', async () => {
    const def = makeDef();
    await strategy.deploy(def);
    expect(await strategy.needsDeploy(def)).toBe(false);
    await fs.writeFile(pluginPath, 'export default function apply(v2) { return v2; }\n');
    expect(await strategy.needsDeploy(def)).toBe(true);
    await strategy.deploy(def);
    expect(await strategy.needsDeploy(def)).toBe(false);
  });

  it('reports redeploy needed when the collection-enabled marker is removed', async () => {
    const def = makeDef();
    await strategy.deploy(def);
    await fs.unlink(enabledMarkerPath);
    expect(await strategy.needsDeploy(def)).toBe(true);
    expect((await strategy.deploy(def)).success).toBe(true);
    expect(await strategy.needsDeploy(def)).toBe(false);
  });

  it('serializes concurrent Pilot deploy writers without duplicating the block', async () => {
    const def = makeDef();
    const [a, b] = await Promise.all([strategy.deploy(def), strategy.deploy(def)]);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    const content = await readPatch();
    expect(content.match(new RegExp(`# BEGIN ${MARKER}`, 'g'))).toHaveLength(1);
    await expect(fs.stat(`${patchPath}.loongsuite-pilot.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recomposes from an external edit that lands after temp fsync', async () => {
    const def = makeDef();
    await strategy.deploy(def);
    const original = await fs.readFile(patchPath);
    const edited = Buffer.concat([Buffer.from('# concurrent-user-edit\n'), original]);
    let callCount = 0;
    const spy = vi.spyOn(
      strategy as unknown as { readBytes: (p: string) => Promise<Buffer> },
      'readBytes',
    );
    spy.mockImplementation(async (p: string) => {
      if (p !== patchPath) return fs.readFile(p);
      callCount++;
      if (callCount === 3) {
        await fs.writeFile(patchPath, edited);
        return edited;
      }
      return fs.readFile(patchPath);
    });
    try {
      const result = await strategy.deploy(def);
      expect(result.success).toBe(true);
      expect(await readPatch()).toMatch(/^# concurrent-user-edit\n/);
    } finally {
      spy.mockRestore();
    }
  });

  it('recovers a stale Pilot lock', async () => {
    const lockPath = `${patchPath}.loongsuite-pilot.lock`;
    await fs.writeFile(lockPath, 'abandoned');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, old, old);
    expect((await strategy.deploy(makeDef())).success).toBe(true);
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes concurrent stale-lock reclaimers without deleting a new owner lock', async () => {
    const lockPath = `${patchPath}.loongsuite-pilot.lock`;
    const gatePath = `${lockPath}.reclaim`;
    await fs.writeFile(lockPath, 'abandoned');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, old, old);

    const otherStrategy = new DshYamlPatchStrategy(tmpDir);
    const [a, b] = await Promise.all([
      strategy.deploy(makeDef()),
      otherStrategy.deploy(makeDef()),
    ]);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect((await readPatch()).match(new RegExp(`# BEGIN ${MARKER}`, 'g'))).toHaveLength(1);
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(gatePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('detects concurrent modification by same-size/mtime but different bytes', async () => {
    const def = makeDef();
    await strategy.deploy(def);
    const original = await fs.readFile(patchPath);

    // Simulate concurrent modification: same length, different bytes.
    // We swap the BEGIN marker to a sentinel that produces same byte length.
    const hostile = original.toString('utf-8').replace(
      `# BEGIN ${MARKER}`,
      `# XEGIN ${MARKER}`,
    );
    expect(hostile.length).toBe(original.length);

    // Race: strategy's readBytes returns original for the initial deploy
    // read (so h0 = sha(original)) and hostile for every subsequent read
    // inside atomicWriteIfUnchanged (so h1 = sha(hostile) ≠ h0). Despite
    // same size/mtime, the byte-hash guard must reject the write.
    const hostileBuf = Buffer.from(hostile);
    let callCount = 0;
    const spy = vi.spyOn(
      strategy as unknown as { readBytes: (p: string) => Promise<Buffer> },
      'readBytes',
    );
    spy.mockImplementation(async (p: string) => {
      if (p === patchPath) {
        callCount++;
        return callCount % 2 === 1 ? original : hostileBuf;
      }
      // Fallback for any other path (should not happen in this test).
      return fs.readFile(p);
    });
    try {
      const result = await strategy.deploy(def);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/concurrent/);
    } finally {
      spy.mockRestore();
    }
  });

  it('uses DSH_HOME env when patchPath omitted', async () => {
    process.env.DSH_HOME = tmpDir;
    try {
      const def = makeDef() as AgentDefinition;
      delete (def.dshYamlPatch as { patchPath?: string }).patchPath;
      // pluginSource already an absolute path → strategy uses it directly
      await strategy.deploy(def);
      const content = await fs.readFile(path.join(tmpDir, 'cordis.patch.yml'), 'utf-8');
      expect(content).toContain(`# BEGIN ${MARKER}`);
    } finally {
      delete process.env.DSH_HOME;
    }
  });

  it('uses the persisted patch path after DSH_HOME changes', async () => {
    const originalDshHome = process.env.DSH_HOME;
    const homeA = path.join(tmpDir, 'home-a');
    const homeB = path.join(tmpDir, 'home-b');
    const pathA = path.join(homeA, 'cordis.patch.yml');
    const pathB = path.join(homeB, 'cordis.patch.yml');
    const def = makeDef();
    delete (def.dshYamlPatch as { patchPath?: string }).patchPath;
    try {
      process.env.DSH_HOME = homeA;
      expect((await strategy.deploy(def)).success).toBe(true);
      const record = {
        deployMode: 'dsh-yaml-patch' as const,
        deployedAt: new Date().toISOString(),
        dshPatchPath: pathA,
      };

      process.env.DSH_HOME = homeB;
      expect(await strategy.needsDeploy(def, record)).toBe(false);
      expect(await strategy.undeploy(def, record)).toBe(true);
      await expect(fs.stat(pathA)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(pathB)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (originalDshHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = originalDshHome;
    }
  });

  it('undeploy is a no-op when no patch file exists', async () => {
    const def = makeDef();
    const ok = await strategy.undeploy(def);
    expect(ok).toBe(true);
  });

  it('undeploy does not recreate a missing persisted DSH home', async () => {
    const missingHome = path.join(tmpDir, 'missing-persisted-home');
    const missingPatch = path.join(missingHome, 'cordis.patch.yml');
    const record = {
      deployMode: 'dsh-yaml-patch' as const,
      deployedAt: new Date().toISOString(),
      dshPatchPath: missingPatch,
    };

    expect(await strategy.undeploy(makeDef(), record)).toBe(true);
    await expect(fs.stat(missingHome)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns false from needsDeploy when dshYamlPatch is missing', async () => {
    const def = makeDef({ dshYamlPatch: undefined } as Partial<AgentDefinition>);
    expect(await strategy.needsDeploy(def)).toBe(false);
  });

  it('deploy fails when plugin file is missing', async () => {
    await fs.unlink(pluginPath);
    const def = makeDef();
    const result = await strategy.deploy(def);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/plugin file not found/);
  });

  it('produces a stable pluginSource file:// URL in the block', async () => {
    const def = makeDef();
    await strategy.deploy(def);
    const content = await readPatch();
    const expected = `file://${pluginPath}`;
    expect(content).toContain(`# pluginSource=${expected}`);
    expect(content).toContain(`name: ${expected}`);
  });
});
