import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = path.resolve(import.meta.dirname ?? __dirname, '..', '..', '..', 'scripts', 'migrate-internal-config.js');
const scriptExists = fs.existsSync(SCRIPT_PATH);

let migrate: (configPath: string) => boolean;
if (scriptExists) {
  ({ migrate } = await import('../../../scripts/migrate-internal-config.js'));
}

const INTERNAL_SLS = {
  name: 'internal-sls',
  endpoint: 'https://cn-heyuan.log.aliyuncs.com',
  project: 'ai-coding-devops',
  logstore: 'loongsuite_pilot_for_ai_coding',
  mode: 'webtracking',
};

describe.skipIf(!scriptExists)('migrate-internal-config', () => {
  let tmpDir: string;
  let configPath: string;
  let innerDataConfigPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-migrate-'));
    configPath = path.join(tmpDir, 'config.json');
    innerDataConfigPath = path.join(tmpDir, 'configs', 'inner', 'data_config.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(data: Record<string, unknown>) {
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2));
  }

  function readConfig() {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  function readInnerDataConfig() {
    return JSON.parse(fs.readFileSync(innerDataConfigPath, 'utf-8'));
  }

  it('returns false when config.json does not exist', () => {
    expect(migrate(configPath)).toBe(false);
  });

  it('returns false for commercial installs (internal === false)', () => {
    writeConfig({ internal: false, sls: { project: 'user-proj', logstore: 'user-store' } });
    expect(migrate(configPath)).toBe(false);
  });

  describe('sls as array with internal + user endpoints', () => {
    it('moves internal SLS to data_config.json and keeps user SLS in config.json', () => {
      writeConfig({
        sls: [
          { name: 'user-sls', endpoint: 'https://cn-hangzhou.log.aliyuncs.com', project: 'user-proj', logstore: 'user-store' },
          { ...INTERNAL_SLS },
        ],
      });

      migrate(configPath);

      const cfg = readConfig();
      expect(cfg.sls).toHaveLength(1);
      expect(cfg.sls[0].project).toBe('user-proj');

      const inner = readInnerDataConfig();
      expect(inner.sls).toHaveLength(1);
      expect(inner.sls[0].project).toBe('ai-coding-devops');
    });
  });

  describe('sls as array with only internal endpoint', () => {
    it('removes sls field from config.json entirely', () => {
      writeConfig({
        sls: [{ ...INTERNAL_SLS }],
        userId: 'test-user',
      });

      migrate(configPath);

      const cfg = readConfig();
      expect(cfg.sls).toBeUndefined();
      expect(cfg.userId).toBe('test-user');

      const inner = readInnerDataConfig();
      expect(inner.sls[0].project).toBe('ai-coding-devops');
    });
  });

  describe('sls as flat object (internal endpoint)', () => {
    it('removes sls field from config.json', () => {
      writeConfig({
        sls: {
          endpoint: 'https://cn-heyuan.log.aliyuncs.com',
          project: 'ai-coding-devops',
          logstore: 'loongsuite_pilot_for_ai_coding',
        },
      });

      migrate(configPath);

      const cfg = readConfig();
      expect(cfg.sls).toBeUndefined();

      const inner = readInnerDataConfig();
      expect(inner.sls[0].project).toBe('ai-coding-devops');
    });
  });

  describe('sls as flat object (user endpoint, not internal)', () => {
    it('keeps user SLS in config.json unchanged', () => {
      writeConfig({
        sls: {
          endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
          project: 'user-proj',
          logstore: 'user-store',
        },
      });

      migrate(configPath);

      const cfg = readConfig();
      expect(cfg.sls).toEqual({
        endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
        project: 'user-proj',
        logstore: 'user-store',
      });

      const inner = readInnerDataConfig();
      expect(inner.sls[0].project).toBe('ai-coding-devops');
    });
  });

  describe('no sls field in config.json', () => {
    it('creates data_config.json with internal SLS', () => {
      writeConfig({ userId: 'test-user' });

      migrate(configPath);

      const inner = readInnerDataConfig();
      expect(inner.sls[0].project).toBe('ai-coding-devops');
    });
  });

  describe('data_config.json already exists', () => {
    it('overwrites with latest internal SLS values', () => {
      fs.mkdirSync(path.dirname(innerDataConfigPath), { recursive: true });
      fs.writeFileSync(innerDataConfigPath, JSON.stringify({
        sls: [{ name: 'old', endpoint: 'https://old.endpoint.com', project: 'old-proj', logstore: 'old-store' }],
      }));

      writeConfig({ userId: 'test-user' });

      migrate(configPath);

      const inner = readInnerDataConfig();
      expect(inner.sls).toHaveLength(1);
      expect(inner.sls[0].project).toBe('ai-coding-devops');
    });
  });

  describe('idempotency', () => {
    it('produces identical results when run twice', () => {
      writeConfig({
        sls: [
          { name: 'user-sls', endpoint: 'https://cn-hangzhou.log.aliyuncs.com', project: 'user-proj', logstore: 'user-store' },
          { ...INTERNAL_SLS },
        ],
        internal: true,
      });

      migrate(configPath);
      const cfg1 = readConfig();
      const inner1 = readInnerDataConfig();

      migrate(configPath);
      const cfg2 = readConfig();
      const inner2 = readInnerDataConfig();

      expect(cfg1).toEqual(cfg2);
      expect(inner1).toEqual(inner2);
    });
  });

  describe('deprecated internal field removal', () => {
    it('removes internal field from config.json', () => {
      writeConfig({ internal: true, userId: 'test-user' });

      migrate(configPath);

      const cfg = readConfig();
      expect(cfg.internal).toBeUndefined();
      expect(cfg.userId).toBe('test-user');
    });
  });

  describe('autoUpdate.packageUrl', () => {
    it('sets packageUrl when missing', () => {
      writeConfig({ userId: 'test-user' });

      migrate(configPath);

      const cfg = readConfig();
      expect(cfg.autoUpdate?.packageUrl).toBeTruthy();
      expect(cfg.autoUpdate.packageUrl).toContain('loongsuite-pilot.tar.gz');
    });

    it('preserves existing packageUrl', () => {
      writeConfig({
        autoUpdate: { packageUrl: 'https://custom.url/package.tar.gz' },
      });

      migrate(configPath);

      const cfg = readConfig();
      expect(cfg.autoUpdate.packageUrl).toBe('https://custom.url/package.tar.gz');
    });
  });

  describe('return value reflects config.json changes', () => {
    it('returns true when config.json was modified', () => {
      writeConfig({
        sls: [{ ...INTERNAL_SLS }],
      });

      expect(migrate(configPath)).toBe(true);
    });

    it('returns false when config.json needs no changes', () => {
      writeConfig({
        autoUpdate: { packageUrl: 'https://existing.url/pkg.tar.gz' },
      });

      expect(migrate(configPath)).toBe(false);
      expect(fs.existsSync(innerDataConfigPath)).toBe(true);
    });
  });

  describe('internal endpoint identified by project field', () => {
    it('removes endpoint matched by project even without name field', () => {
      writeConfig({
        sls: [
          { endpoint: 'https://cn-heyuan.log.aliyuncs.com', project: 'ai-coding-devops', logstore: 'loongsuite_pilot_for_ai_coding' },
        ],
      });

      migrate(configPath);

      const cfg = readConfig();
      expect(cfg.sls).toBeUndefined();

      const inner = readInnerDataConfig();
      expect(inner.sls[0].project).toBe('ai-coding-devops');
    });
  });
});
