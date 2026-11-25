import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn, error: vi.fn(),
  }),
}));

import { createUserIdProvider, USER_ID_REFRESH_INTERVAL_MS } from '../../../src/core/config-loader.js';

const CONFIG_PATH = '/tmp/loongsuite-pilot-test/config.json';

function makeReader(map: { current: string }): (p: string) => string {
  return () => map.current;
}

describe('createUserIdProvider', () => {
  beforeEach(() => {
    vi.stubEnv('LOONGSUITE_PILOT_USER_ID', '');
    warn.mockClear();
  });

  afterEach(() => vi.unstubAllEnvs());

  it('reads userId from config on the first call', () => {
    const file = { current: JSON.stringify({ userId: '326220' }) };
    const get = createUserIdProvider({
      initialUserId: 'startup-host',
      configPath: CONFIG_PATH,
      readFile: makeReader(file),
      now: () => 0,
    });
    expect(get()).toBe('326220');
  });

  it('does not pick up config changes within the refresh interval', () => {
    const file = { current: JSON.stringify({ userId: 'old' }) };
    let clock = 0;
    const get = createUserIdProvider({
      initialUserId: 'startup',
      configPath: CONFIG_PATH,
      readFile: makeReader(file),
      now: () => clock,
    });
    expect(get()).toBe('old');

    file.current = JSON.stringify({ userId: 'new' });
    clock = USER_ID_REFRESH_INTERVAL_MS - 1;
    expect(get()).toBe('old'); // still cached
  });

  it('re-reads config once the refresh interval elapses', () => {
    const file = { current: JSON.stringify({ userId: 'old' }) };
    let clock = 0;
    const get = createUserIdProvider({
      initialUserId: 'startup',
      configPath: CONFIG_PATH,
      readFile: makeReader(file),
      now: () => clock,
    });
    expect(get()).toBe('old');

    file.current = JSON.stringify({ userId: '326220' });
    clock = USER_ID_REFRESH_INTERVAL_MS;
    expect(get()).toBe('326220');
  });

  it('honors env override over the config file', () => {
    vi.stubEnv('LOONGSUITE_PILOT_USER_ID', 'from-env');
    try {
      const file = { current: JSON.stringify({ userId: 'from-file' }) };
      const get = createUserIdProvider({
        initialUserId: 'startup',
        configPath: CONFIG_PATH,
        readFile: makeReader(file),
        now: () => 0,
      });
      expect(get()).toBe('from-env');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("falls back to user.id then hostname when userId is absent", () => {
    const legacy = createUserIdProvider({
      initialUserId: 'startup',
      configPath: CONFIG_PATH,
      readFile: () => JSON.stringify({ 'user.id': 'legacy-id' }),
      now: () => 0,
    });
    expect(legacy()).toBe('legacy-id');

    const none = createUserIdProvider({
      initialUserId: 'startup',
      configPath: CONFIG_PATH,
      readFile: () => JSON.stringify({}),
      now: () => 0,
    });
    expect(none()).toBe(os.hostname());
  });

  it('treats an empty/whitespace userId as unset and falls back to hostname', () => {
    const get = createUserIdProvider({
      initialUserId: 'startup',
      configPath: CONFIG_PATH,
      readFile: () => JSON.stringify({ userId: '   ' }),
      now: () => 0,
    });
    expect(get()).toBe(os.hostname());
  });

  it('keeps the last known good value when the config read fails', () => {
    const file = { current: JSON.stringify({ userId: '326220' }) };
    let clock = 0;
    const get = createUserIdProvider({
      initialUserId: 'startup',
      configPath: CONFIG_PATH,
      readFile: () => {
        const v = file.current;
        if (v === '__throw__') throw new Error('ENOENT');
        return v;
      },
      now: () => clock,
    });
    expect(get()).toBe('326220');

    file.current = '__throw__';
    clock = USER_ID_REFRESH_INTERVAL_MS;
    expect(get()).toBe('326220'); // unchanged on read error
  });

  it('uses the configured path and accepts a BOM and numeric user ID', () => {
    vi.stubEnv('AGENT_DATA_COLLECTION_CONFIG', ` ${CONFIG_PATH} `);
    const readFile = vi.fn(() => '\uFEFF{"userId":326220}');
    const get = createUserIdProvider({ initialUserId: 'startup', readFile });

    expect(get()).toBe('326220');
    expect(readFile.mock.calls).toEqual([[CONFIG_PATH]]);
  });

  it('preserves the last good ID and warns once per window without logging invalid config content', () => {
    const readFile = vi.fn(() => '{"apiKey":"private-value",}');
    let clock = 0;
    const get = createUserIdProvider({ initialUserId: 'startup', configPath: CONFIG_PATH, readFile, now: () => clock });

    expect(get()).toBe('startup');
    expect(get()).toBe('startup');
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls).toEqual([['userId refresh failed, keeping last known value', {
      error: 'SyntaxError',
      path: CONFIG_PATH,
    }]]);

    clock = USER_ID_REFRESH_INTERVAL_MS;
    readFile.mockReturnValueOnce('{"userId":"recovered"}');
    expect(get()).toBe('recovered');
  });
});
