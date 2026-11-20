import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { readCopilotFile, writeCopilotFile } from '../../../src/deployment/copilot-config-file.js';
describe('Copilot user file atomic updates', () => {
  it('rejects concurrent edits and retains the concurrent contents', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-atomic-'));
    try {
      const file = path.join(dir, 'config.json'); await fs.writeFile(file, '{"original":true}');
      const snapshot = await readCopilotFile(file);
      await fs.writeFile(file, '{"userEdit":true}');
      await expect(writeCopilotFile(snapshot, '{"pilot":true}')).rejects.toThrow('file changed');
      expect(await fs.readFile(file, 'utf8')).toBe('{"userEdit":true}');
      expect(await fs.readdir(dir)).toEqual(['config.json']);
    } finally { await fs.rm(dir, {recursive:true,force:true}); }
  });
});
