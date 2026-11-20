import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readNativeProfileGraph } from '../../../src/inputs/doubao-work/doubao-work-native.js';
import { DOUBAO_NATIVE_FILES } from '../../helpers/doubao-work-fixture.js';

describe('Doubao native conversation lookup after an account switch', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-profiles-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  async function seed(profile: string, conversation = '12345'): Promise<void> {
    for (const [agent, content] of Object.entries(DOUBAO_NATIVE_FILES)) {
      const folder = path.join(root, profile, '.doubaowork/agent_mode/workspace/.sessions', conversation, 'agents', agent, 'system');
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'trajectory.jsonl'), content);
    }
  }
  it.each(['Default', 'Profile 3'])('links the exact conversation in %s', async profile => {
    await seed(profile);
    const graph = await readNativeProfileGraph(root, '12345');
    expect(graph?.edges.s_nativeLeaf.parent).toBe('o_nativeOrg');
    expect(JSON.stringify(graph)).not.toContain('SYNTHETIC_PRIVATE');
  });
  it('does not select a stale Default conversation over the new account', async () => {
    await seed('Default', '99999');
    await seed('Profile 3');
    expect((await readNativeProfileGraph(root, '12345'))?.main).toBe('m_nativeMain');
    expect(await readNativeProfileGraph(root, 'missing')).toBeUndefined();
  });
  it('does not guess when two profiles contain the same conversation', async () => {
    await seed('Default');
    await seed('Profile 3');
    expect(await readNativeProfileGraph(root, '12345')).toBeUndefined();
  });
  it('ignores arbitrary directories and rejects unsafe conversation IDs', async () => {
    await seed('unrelated');
    expect(await readNativeProfileGraph(root, '12345')).toBeUndefined();
    expect(await readNativeProfileGraph(root, '../12345')).toBeUndefined();
  });
  it('bounds the number of profiles and does not follow a profile symlink', async () => {
    await seed('Default');
    await fs.symlink(path.join(root, 'Default'), path.join(root, 'Profile 3'), 'junction');
    expect(await readNativeProfileGraph(root, '12345')).toBeUndefined();
    await fs.unlink(path.join(root, 'Profile 3'));
    for (let i = 0; i < 16; i++) await fs.mkdir(path.join(root, `Profile ${i}`));
    expect(await readNativeProfileGraph(root, '12345')).toBeUndefined();
  });
});
