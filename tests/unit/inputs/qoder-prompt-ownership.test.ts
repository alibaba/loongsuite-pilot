import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readQoderPromptOwnership, type QoderOwnershipCursor, type QoderOwnershipSearch } from '../../../src/inputs/qoder-trace/prompt-ownership.js';
import { queryReadonly } from '../../../src/utils/node-sqlite.js';

vi.mock('../../../src/utils/node-sqlite.js', () => ({ queryReadonly: vi.fn() }));
const discovery = vi.hoisted(() => ({ paths: ['synthetic.db'], inode: 7 }));
vi.mock('../../../src/inputs/qoder-trace/sqlite-token-reader.js', () => ({ resolveAllQoderDbPaths: () => discovery.paths }));
vi.mock('../../../src/inputs/qoder-cn-trace/sqlite-token-reader.js', () => ({ resolveQoderCnDbPaths: () => discovery.paths }));
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<object>(), statSync: () => ({ dev: 1, ino: discovery.inode }) }));
let inventory: Array<{ request_id: string; gmt_create: number | string }>;
beforeEach(() => {
  discovery.paths = ['synthetic.db']; discovery.inode = 7;
  inventory = [{ request_id: 'owned', gmt_create: 100 }];
  vi.mocked(queryReadonly).mockReset().mockImplementation(async (_file, sql, args) => {
    if (!sql.includes('ORDER BY')) return inventory.filter(row => row.request_id === args[1]).slice(0, 2);
    return inventory.filter(row => !args[1] || Number(row.gmt_create) > Number(args[2])
      || (row.gmt_create === args[2] && row.request_id > String(args[4])))
      .sort((a, b) => Number(a.gmt_create) - Number(b.gmt_create)).slice(0, 257);
  });
});

describe.each(['qoder', 'qoder-cn'] as const)('%s prompt request ownership', agent => {
  it('returns a complete metadata-only inventory anchored to the exact request', async () => {
    inventory = [{ request_id: 'second', gmt_create: 200 }, { request_id: 'first', gmt_create: '100' }];
    expect(await readQoderPromptOwnership(agent, 'native-session', 'second')).toEqual({ inventoryId: expect.any(String),
      rows: [{ requestId: 'first', at: 100 }, { requestId: 'second', at: 200 }], complete: true });
    expect(vi.mocked(queryReadonly).mock.calls.every(call => !/SELECT\s+\*|content|question|answer/i.test(call[1]))).toBe(true);
    expect(vi.mocked(queryReadonly).mock.calls[0]![2]).toEqual(['native-session', 'second']);
  });
  it.each([
    [[{ request_id: 'owned', gmt_create: 100 }, { request_id: 'other', gmt_create: 100 }]],
    [[{ request_id: 'owned', gmt_create: 100 }, { request_id: 'owned', gmt_create: 200 }]],
    [[{ request_id: 'owned', gmt_create: 'invalid' }]],
  ])('does not claim a tied, duplicate or corrupt inventory', async rows => {
    inventory = rows;
    expect(await readQoderPromptOwnership(agent, 'native-session', 'owned')).toBeNull();
  });
  it('streams more than 1000 Turns with bounded keyset pages and no duplicates', async () => {
    inventory = Array.from({ length: 1025 }, (_, i) => ({ request_id: 'owned-' + i, gmt_create: i + 1 }));
    const delivered = []; let cursor: QoderOwnershipCursor | undefined;
    for (let i = 0; i < 6; i++) {
      const page = await readQoderPromptOwnership(agent, 'native-session', 'owned-1024', cursor);
      expect(page).not.toBeNull(); expect(page!.rows.length).toBeLessThanOrEqual(256);
      delivered.push(...page!.rows);
      if (page!.complete) break;
      cursor = { ...page!.rows.at(-1)!, inventoryId: page!.inventoryId };
    }
    expect(delivered).toHaveLength(1025);
    expect(new Set(delivered.map(row => row.requestId)).size).toBe(1025);
  });
  it('restarts the proof when the DB identity or previously paired row changed', async () => {
    const page = await readQoderPromptOwnership(agent, 'native-session', 'owned', { at: 99, requestId: 'owned', inventoryId: 'old-file' });
    expect(page?.reset).toBe(true);
  });
  it('retries after temporary database failure instead of recording a false baseline', async () => {
    vi.mocked(queryReadonly).mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    expect(await readQoderPromptOwnership(agent, 'native-session', 'owned')).toBeNull();
    expect(await readQoderPromptOwnership(agent, 'native-session', 'owned')).toEqual({ inventoryId: expect.any(String), rows: [{ requestId: 'owned', at: 100 }], complete: true });
  });

  it('rotates beyond four candidates across persisted search state, then prefers the verified database', async () => {
    discovery.paths = Array.from({ length: 9 }, (_, i) => `synthetic-${i}.db`);
    const original = vi.mocked(queryReadonly).getMockImplementation()!;
    vi.mocked(queryReadonly).mockImplementation(async (...args) => args[0] === 'synthetic-8.db' ? original(...args) : []);
    let search: QoderOwnershipSearch = {};
    for (let i = 0; i < 2; i++) {
      vi.mocked(queryReadonly).mockClear();
      expect(await readQoderPromptOwnership(agent, 'native-session', 'owned', undefined, search)).toBeNull();
      expect(vi.mocked(queryReadonly).mock.calls).toHaveLength(4);
      search = JSON.parse(JSON.stringify(search)); // Same state representation as a collector restart.
    }
    vi.mocked(queryReadonly).mockClear();
    const page = await readQoderPromptOwnership(agent, 'native-session', 'owned', undefined, search);
    expect(page?.rows).toEqual([{ requestId: 'owned', at: 100 }]);
    expect(new Set(vi.mocked(queryReadonly).mock.calls.map(call => call[0]))).toEqual(new Set(['synthetic-8.db']));
    expect(JSON.stringify(search).length).toBeLessThan(1024);
    vi.mocked(queryReadonly).mockClear();
    expect(await readQoderPromptOwnership(agent, 'native-session', 'owned', undefined, search)).not.toBeNull();
    expect(vi.mocked(queryReadonly).mock.calls.every(call => call[0] === 'synthetic-8.db')).toBe(true);
  });

  it('does not query a removed preferred database or let reordered discovery starve the remaining candidates', async () => {
    discovery.paths = Array.from({ length: 9 }, (_, i) => `synthetic-${i}.db`);
    const original = vi.mocked(queryReadonly).getMockImplementation()!;
    vi.mocked(queryReadonly).mockImplementation(async (...args) => args[0] === 'synthetic-8.db' ? original(...args) : []);
    const search: QoderOwnershipSearch = { preferredPath: 'removed.db', nextIndex: 4 };
    for (let i = 0; i < 3; i++) {
      discovery.paths.reverse(); vi.mocked(queryReadonly).mockClear();
      const page = await readQoderPromptOwnership(agent, 'native-session', 'owned', undefined, search);
      expect(vi.mocked(queryReadonly).mock.calls.some(call => call[0] === 'removed.db')).toBe(false);
      expect(new Set(vi.mocked(queryReadonly).mock.calls.map(call => call[0])).size).toBeLessThanOrEqual(4);
      if (page) { expect(page.rows[0]?.requestId).toBe('owned'); return; }
    }
    throw new Error('The last supported candidate was never queried');
  });

  it('validates the preferred database generation before continuing its inventory page', async () => {
    const search: QoderOwnershipSearch = {};
    const first = await readQoderPromptOwnership(agent, 'native-session', 'owned', undefined, search);
    discovery.inode++;
    const page = await readQoderPromptOwnership(agent, 'native-session', 'owned',
      { at: 100, requestId: 'owned', inventoryId: first!.inventoryId }, search);
    expect(page?.reset).toBe(true);
  });
});
