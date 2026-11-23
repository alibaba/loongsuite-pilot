import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AntigravityDbReadCache,
  readAntigravityConversationDb,
} from '../../../../src/inputs/antigravity/sqlite-reader.js';
import { loadDatabaseSync } from '../../../../src/utils/node-sqlite.js';

function varint(value: number): Buffer {
  const bytes: number[] = [];
  while (value >= 0x80) {
    bytes.push((value % 0x80) | 0x80);
    value = Math.floor(value / 0x80);
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

function bytesField(id: number, bytes: Buffer): Buffer {
  return Buffer.concat([varint(id * 8 + 2), varint(bytes.length), bytes]);
}

function textField(id: number, text: string): Buffer {
  return bytesField(id, Buffer.from(text));
}

function generation(stepIdx: number, responseId: string, tokens = 1): Buffer {
  const usage = Buffer.concat([varint(2 * 8), varint(tokens), textField(11, responseId)]);
  return Buffer.concat([bytesField(1, bytesField(4, usage)), varint(2 * 8), varint(stepIdx)]);
}

describe('Antigravity incremental SQLite reads', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-antigravity-sqlite-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('revisits pending rows and companion indices without fetching settled rows before an audit', async () => {
    const dbPath = path.join(dir, 'session.db');
    const DatabaseSync = loadDatabaseSync()!;
    const db = new DatabaseSync(dbPath);
    const cache = new AntigravityDbReadCache();
    try {
      db.exec(`
        CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
        CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);
        CREATE TABLE trajectory_metadata_blob (data BLOB);
      `);
      const putGen = db.prepare('INSERT OR REPLACE INTO gen_metadata (idx, data) VALUES (?, ?)');
      const putStep = db.prepare('INSERT OR REPLACE INTO steps (idx, metadata) VALUES (?, ?)');
      const publicFolder = path.join(dir, 'first folder');
      const extraFolder = path.join(dir, 'second folder');
      db.prepare('INSERT INTO trajectory_metadata_blob (data) VALUES (?)')
        .run(textField(7, pathToFileURL(publicFolder).href));
      for (let idx = 0; idx <= 10; idx++) {
        putGen.run(idx, generation(idx, `first-${idx}`, idx === 1 ? 0 : 1));
        putStep.run(idx, idx === 1 ? null : textField(12, 'old-turn'));
      }
      const first = await readAntigravityConversationDb(dbPath, undefined, { cache });
      expect(first?.workspacePaths).toEqual([publicFolder]);
      expect(first?.events).toHaveLength(10);
      expect(cache.rowCount).toBe(22);
      expect(cache.pendingRowCount).toBe(2);

      putGen.run(0, generation(0, 'old-row-replaced'));
      putGen.run(1, generation(1, 'late-tokens'));
      putGen.run(2, generation(2, 'linked-row-replaced'));
      putGen.run(11, generation(3, 'new-generation-linked-to-old-step'));
      putStep.run(1, textField(12, 'pending-turn'));
      putStep.run(2, textField(12, 'companion-turn'));
      putStep.run(3, textField(12, 'new-generation-turn'));
      db.prepare('INSERT INTO trajectory_metadata_blob (data) VALUES (?)')
        .run(textField(7, pathToFileURL(extraFolder).href));

      const next = await readAntigravityConversationDb(dbPath, undefined, {
        cache,
        stepIndices: [2],
        refreshWorkspace: true,
      });
      expect(next?.workspacePaths).toEqual([publicFolder, extraFolder]);
      expect(next?.stepInfos.get(1)?.turnId).toBe('pending-turn');
      expect(next?.stepInfos.get(2)?.turnId).toBe('companion-turn');
      expect(next?.stepInfos.get(3)?.turnId).toBe('new-generation-turn');
      const ids = next?.events.map(event => event.messageId);
      expect(ids).toEqual(expect.arrayContaining([
        'first-0', 'late-tokens', 'linked-row-replaced', 'new-generation-linked-to-old-step',
      ]));
      expect(ids).not.toContain('old-row-replaced');
      expect(ids).not.toContain('first-2');
      expect(cache.pendingRowCount).toBe(0);

      const audited = await readAntigravityConversationDb(dbPath, undefined, { cache, forceFull: true });
      const standalone = await readAntigravityConversationDb(dbPath);
      expect(audited).toEqual(standalone);
      expect(audited?.events.map(event => event.messageId)).toContain('old-row-replaced');
    } finally {
      db.close();
    }
  });

  it('limits pending and explicit point reads per table and leaves the rest to a full audit', async () => {
    const dbPath = path.join(dir, 'large-pending.db');
    const DatabaseSync = loadDatabaseSync()!;
    const db = new DatabaseSync(dbPath);
    const cache = new AntigravityDbReadCache();
    const rowCount = 160;
    try {
      db.exec(`
        CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
        CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);
      `);
      const putGen = db.prepare('INSERT OR REPLACE INTO gen_metadata (idx, data) VALUES (?, ?)');
      const putStep = db.prepare('INSERT OR REPLACE INTO steps (idx, metadata) VALUES (?, ?)');
      db.exec('BEGIN');
      for (let idx = 0; idx < rowCount; idx++) {
        putGen.run(idx, generation(idx, `response-${idx}`, 0));
        putStep.run(idx, null);
      }
      db.exec('COMMIT');
      const first = await readAntigravityConversationDb(dbPath, undefined, { cache });
      expect(first?.events).toHaveLength(0);
      expect(first?.stepInfos.size).toBe(0);
      expect(cache.pendingRowCount).toBe(rowCount * 2);

      db.exec('BEGIN');
      for (let idx = 0; idx < rowCount; idx++) {
        putGen.run(idx, generation(idx, `response-${idx}`));
        putStep.run(idx, textField(12, `turn-${idx}`));
      }
      db.exec('COMMIT');

      const pending = await readAntigravityConversationDb(dbPath, undefined, { cache, stepIndices: [0] });
      // The oldest explicit row and 32 newly discovered pending rows in each table.
      expect(pending?.events).toHaveLength(33);
      expect(pending?.stepInfos.size).toBe(33);
      expect(pending?.events.map(event => event.messageId)).toContain('response-0');
      expect(pending?.stepInfos.get(0)?.turnId).toBe('turn-0');
      expect(pending?.stepInfos.get(rowCount - 1)?.turnId).toBe(`turn-${rowCount - 1}`);

      const explicit = await readAntigravityConversationDb(dbPath, undefined, {
        cache,
        stepIndices: Array.from({ length: rowCount - 1 }, (_, i) => i + 1),
      });
      expect(explicit?.events).toHaveLength(33 + 64);
      expect(explicit?.stepInfos.size).toBe(33 + 64);

      const audited = await readAntigravityConversationDb(dbPath, undefined, { cache, forceFull: true });
      expect(audited?.events).toHaveLength(rowCount);
      expect(audited?.stepInfos.size).toBe(rowCount);
      expect(cache.pendingRowCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it('preserves the cache on cancellation and rebuilds after the source frontier moves backwards', async () => {
    const dbPath = path.join(dir, 'session.db');
    const DatabaseSync = loadDatabaseSync()!;
    const db = new DatabaseSync(dbPath);
    const cache = new AntigravityDbReadCache();
    try {
      db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
      const putGen = db.prepare('INSERT OR REPLACE INTO gen_metadata (idx, data) VALUES (?, ?)');
      for (let idx = 0; idx <= 10; idx++) putGen.run(idx, generation(idx, `first-${idx}`));
      await readAntigravityConversationDb(dbPath, undefined, { cache });

      db.exec('DELETE FROM gen_metadata WHERE idx > 5');
      putGen.run(0, generation(0, 'rebuilt'));
      let runningChecks = 0;
      expect(await readAntigravityConversationDb(dbPath, () => ++runningChecks < 2, { cache }))
        .toBeNull();
      expect(cache.rowCount).toBe(11);

      const next = await readAntigravityConversationDb(dbPath, undefined, { cache });
      expect(next?.events.map(event => event.messageId)).toEqual([
        'rebuilt', 'first-1', 'first-2', 'first-3', 'first-4', 'first-5',
      ]);
      expect(cache.rowCount).toBe(6);
    } finally {
      db.close();
    }
  });
});
