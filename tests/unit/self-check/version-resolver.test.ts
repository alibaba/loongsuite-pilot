import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

vi.mock('../../../src/utils/fs-utils.js', () => ({
  resolveHome: (p: string) => p,
}));

import { resolveAgentVersion } from '../../../src/self-check/version-resolver.js';

describe('resolveAgentVersion', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'version-resolver-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('jsonFile', () => {
    it('reads a key from a JSON file', async () => {
      const file = path.join(tmpDir, 'version.json');
      await fs.writeFile(file, JSON.stringify({ latest_version: '0.129.0' }));
      const v = await resolveAgentVersion({ type: 'jsonFile', file, key: 'latest_version' });
      expect(v).toBe('0.129.0');
    });

    it('returns unknown when key is missing', async () => {
      const file = path.join(tmpDir, 'version.json');
      await fs.writeFile(file, JSON.stringify({ other: 'x' }));
      const v = await resolveAgentVersion({ type: 'jsonFile', file, key: 'version' });
      expect(v).toBe('unknown');
    });

    it('returns unknown when file does not exist', async () => {
      const v = await resolveAgentVersion({
        type: 'jsonFile', file: path.join(tmpDir, 'nope.json'), key: 'version',
      });
      expect(v).toBe('unknown');
    });
  });

  describe('jsonlTail', () => {
    it('reads a key from the last valid JSONL line', async () => {
      const file = path.join(tmpDir, 'audit.jsonl');
      await fs.writeFile(file, [
        JSON.stringify({ cursor_version: '3.6.30' }),
        JSON.stringify({ cursor_version: '3.6.31' }),
      ].join('\n') + '\n');
      const v = await resolveAgentVersion({ type: 'jsonlTail', file, key: 'cursor_version' });
      expect(v).toBe('3.6.31');
    });

    it('skips malformed trailing lines and finds the last valid key', async () => {
      const file = path.join(tmpDir, 'audit.jsonl');
      await fs.writeFile(file, [
        JSON.stringify({ cursor_version: '3.6.31' }),
        '{malformed',
      ].join('\n') + '\n');
      const v = await resolveAgentVersion({ type: 'jsonlTail', file, key: 'cursor_version' });
      expect(v).toBe('3.6.31');
    });

    it('returns unknown when no line has the key', async () => {
      const file = path.join(tmpDir, 'audit.jsonl');
      await fs.writeFile(file, JSON.stringify({ other: 'x' }) + '\n');
      const v = await resolveAgentVersion({ type: 'jsonlTail', file, key: 'cursor_version' });
      expect(v).toBe('unknown');
    });
  });

  describe('newestJsonFile', () => {
    it('reads the key from the newest (last-sorted) JSON file in a dir', async () => {
      await fs.writeFile(path.join(tmpDir, '10000.json'), JSON.stringify({ version: '2.1.100' }));
      await fs.writeFile(path.join(tmpDir, '91562.json'), JSON.stringify({ version: '2.1.119' }));
      const v = await resolveAgentVersion({ type: 'newestJsonFile', dir: tmpDir, key: 'version' });
      expect(v).toBe('2.1.119');
    });

    it('returns unknown when dir has no json files', async () => {
      const v = await resolveAgentVersion({ type: 'newestJsonFile', dir: tmpDir, key: 'version' });
      expect(v).toBe('unknown');
    });

    it('returns unknown when dir does not exist', async () => {
      const v = await resolveAgentVersion({
        type: 'newestJsonFile', dir: path.join(tmpDir, 'nope'), key: 'version',
      });
      expect(v).toBe('unknown');
    });
  });

  describe('newestSubdirFile', () => {
    it('reads a key from a file inside the newest subdir', async () => {
      const oldDir = path.join(tmpDir, '2026-07-01T00-00-00');
      const newDir = path.join(tmpDir, '2026-07-02T00-00-00');
      await fs.mkdir(oldDir);
      await fs.mkdir(newDir);
      await fs.writeFile(path.join(oldDir, 'manifest.json'), JSON.stringify({ cli_version: '1.0.27' }));
      await fs.writeFile(path.join(newDir, 'manifest.json'), JSON.stringify({ cli_version: '1.0.28' }));
      const v = await resolveAgentVersion({
        type: 'newestSubdirFile', dir: tmpDir, file: 'manifest.json', key: 'cli_version',
      });
      expect(v).toBe('1.0.28');
    });

    it('returns unknown when there are no subdirs', async () => {
      const v = await resolveAgentVersion({
        type: 'newestSubdirFile', dir: tmpDir, file: 'manifest.json', key: 'cli_version',
      });
      expect(v).toBe('unknown');
    });
  });

  describe('command', () => {
    it('runs a command and returns first line of stdout', async () => {
      const v = await resolveAgentVersion({ type: 'command', command: 'echo 1.14.29' });
      expect(v).toBe('1.14.29');
    });

    it('returns unknown when command fails', async () => {
      const v = await resolveAgentVersion({ type: 'command', command: 'nonexistent-binary-xyz' });
      expect(v).toBe('unknown');
    });
  });
});
