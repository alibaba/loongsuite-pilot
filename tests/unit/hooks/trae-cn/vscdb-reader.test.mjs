import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/trae-cn-hook-processor.mjs');

let tmpDir;
let vscdbDir;
let vscdbPath;
let mod;
let origTraesUserDataDir;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-cn-vscdb-test-'));
  vscdbDir = path.join(tmpDir, 'User', 'globalStorage');
  fs.mkdirSync(vscdbDir, { recursive: true });
  vscdbPath = path.join(vscdbDir, 'state.vscdb');
  origTraesUserDataDir = process.env.TRAES_USER_DATA_DIR;
  process.env.TRAES_USER_DATA_DIR = vscdbDir;
  mod = await import(PROCESSOR);
  // readTraeVscdbModelCatalogSync memoises on the module; without clearing,
  // the first picker test's catalog leaks into every later test. Reset so
  // each test sees the vscdb it just built.
  if (mod.readTraeVscdbModelCatalogSync._cache !== undefined) {
    mod.readTraeVscdbModelCatalogSync._cache = undefined;
  }
});

afterEach(() => {
  if (origTraesUserDataDir === undefined) delete process.env.TRAES_USER_DATA_DIR;
  else process.env.TRAES_USER_DATA_DIR = origTraesUserDataDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Build a synthetic state.vscdb with given ItemTable rows.
// Rows: array of { key, value }.
function buildVscdb(rows) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(vscdbPath);
  db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT, value TEXT)');
  const stmt = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
  for (const r of rows) stmt.run(r.key, r.value);
  db.close();
}

// Deployer-confirmed vscdb schema for AI.agent.model.model_list_map:
//   { "<user_id>": { "<agent_type>": { modelId, mode, ... } } }
// where agent_type keys are snake_case variants (solo_agent, builder, ...).
// modelId carries a synthetic prefix `<agent_type>_<N>__<real_model_name>`
// that the picker must strip before returning.
const CATALOG_SOLO_AGENT_DEFAULT = {
  '6af6d570164695484f84f7f1': {
    solo_agent: { modelId: 'solo_agent_1__Doubao-Seed-Code', mode: 1 },
  },
};

const CATALOG_BUILDER_EMPTY = {
  '6af6d570164695484f84f7f1': {
    builder: {},
  },
};

describe('Trae-CN vscdb reader — P0 dual-path', () => {
  it('Path A (node:sqlite) hit: queryVscdbValueSync returns the row value', () => {
    buildVscdb([{ key: 'someUserId_AI.agent.model.model_list_map', value: JSON.stringify(CATALOG_SOLO_AGENT_DEFAULT) }]);
    const raw = mod.queryVscdbValueSync('AI.agent.model.model_list_map', vscdbPath);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw);
    expect(parsed['6af6d570164695484f84f7f1'].solo_agent.modelId).toBe('solo_agent_1__Doubao-Seed-Code');
  });

  it('Path A fail (file missing) → fallback B/C also fail → returns null', () => {
    // Path A throws on non-existent file. queryVscdbValueSync short-circuits
    // via the fs.existsSync guard; all 3 paths fail → null.
    const missing = path.join(vscdbDir, 'nope.vscdb');
    expect(mod.queryVscdbValueSync('anyKey', missing)).toBeNull();
  });

  it('Path B (sqlite3 CLI) independently resolves value when called directly', () => {
    buildVscdb([{ key: 'session_selected_model', value: 'Doubao-Seed-2.1-Turbo' }]);
    const val = mod.queryVscdbViaSqlite3Cli('session_selected_model', vscdbPath);
    expect(val).toBe('Doubao-Seed-2.1-Turbo');
  });

  it('Path C (python3 sqlite3) independently resolves value when called directly', () => {
    buildVscdb([{ key: 'ai_assistant.request.model', value: 'Qwen-Coder-32B' }]);
    const val = mod.queryVscdbViaPython3('ai_assistant.request.model', vscdbPath);
    expect(val).toBe('Qwen-Coder-32B');
  });
});

describe('Trae-CN vscdb reader — P1-1 path resolver', () => {
  it('resolves vscdb from TRAES_USER_DATA_DIR env', () => {
    buildVscdb([{ key: 'k', value: 'v' }]);
    expect(mod.resolveVscdbPath({})).toBe(vscdbPath);
  });

  it('falls back to event.user_data_dir when env unset', () => {
    delete process.env.TRAES_USER_DATA_DIR;
    const altDir = path.join(tmpDir, 'alt-globalStorage');
    fs.mkdirSync(altDir, { recursive: true });
    const altPath = path.join(altDir, 'state.vscdb');
    // Copy vscdb into alt dir
    buildVscdb([{ key: 'k', value: 'v' }]);
    fs.copyFileSync(vscdbPath, altPath);
    fs.unlinkSync(vscdbPath);
    expect(mod.resolveVscdbPath({ user_data_dir: altDir })).toBe(altPath);
  });

  it('returns null when no vscdb found anywhere', () => {
    delete process.env.TRAES_USER_DATA_DIR;
    if (fs.existsSync(vscdbPath)) fs.unlinkSync(vscdbPath);
    expect(mod.resolveVscdbPath({})).toBeNull();
  });
});

// Trae's standard layout puts state.vscdb at
// `<user-data-dir>/User/globalStorage/state.vscdb`. The previous resolver
// only tried `<user-data-dir>/state.vscdb` for the env and event paths,
// missing the standard layout (deployer-confirmed bug: /tmp/trae-p7 has
// state.vscdb under User/globalStorage, not directly under the user-data-dir).
describe('Trae-CN vscdb reader — P1-1 path resolver standard layout', () => {
  let stdTmpDir;
  let stdUserDataDir;
  let stdVscdbPath;

  beforeEach(() => {
    stdTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-cn-std-layout-'));
    stdUserDataDir = path.join(stdTmpDir, 'user-data-dir');
    fs.mkdirSync(path.join(stdUserDataDir, 'User', 'globalStorage'), { recursive: true });
    stdVscdbPath = path.join(stdUserDataDir, 'User', 'globalStorage', 'state.vscdb');
    origTraesUserDataDir = process.env.TRAES_USER_DATA_DIR;
  });

  afterEach(() => {
    if (origTraesUserDataDir === undefined) delete process.env.TRAES_USER_DATA_DIR;
    else process.env.TRAES_USER_DATA_DIR = origTraesUserDataDir;
    fs.rmSync(stdTmpDir, { recursive: true, force: true });
  });

  it('TRAES_USER_DATA_DIR=<user-data-dir> → resolves User/globalStorage/state.vscdb', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(stdVscdbPath);
    db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT, value TEXT)');
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('k', 'v');
    db.close();
    process.env.TRAES_USER_DATA_DIR = stdUserDataDir;
    expect(mod.resolveVscdbPath({})).toBe(stdVscdbPath);
  });

  it('event.user_data_dir=<user-data-dir> (env unset) → resolves User/globalStorage/state.vscdb', () => {
    delete process.env.TRAES_USER_DATA_DIR;
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(stdVscdbPath);
    db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT, value TEXT)');
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('k', 'v');
    db.close();
    expect(mod.resolveVscdbPath({ user_data_dir: stdUserDataDir })).toBe(stdVscdbPath);
  });

  it('returns null when neither standard nor legacy layout has state.vscdb', () => {
    delete process.env.TRAES_USER_DATA_DIR;
    // No state.vscdb created anywhere.
    expect(mod.resolveVscdbPath({ user_data_dir: stdUserDataDir })).toBeNull();
  });

  it('legacy direct layout (state.vscdb under user-data-dir) still resolves', () => {
    delete process.env.TRAES_USER_DATA_DIR;
    const legacyPath = path.join(stdUserDataDir, 'state.vscdb');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(legacyPath);
    db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT, value TEXT)');
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('k', 'v');
    db.close();
    expect(mod.resolveVscdbPath({ user_data_dir: stdUserDataDir })).toBe(legacyPath);
  });
});

describe('Trae-CN agent_type mapper — P1-2 normalization', () => {
  it('maps Builder / BuilderWithMcp / Chat → builder', () => {
    expect(mod.normalizeAgentType('Builder')).toBe('builder');
    expect(mod.normalizeAgentType('BuilderWithMcp')).toBe('builder');
    expect(mod.normalizeAgentType('Chat')).toBe('builder');
  });

  it('maps SoloCoder / SoloAgent → solo_coder', () => {
    expect(mod.normalizeAgentType('SoloCoder')).toBe('solo_coder');
    expect(mod.normalizeAgentType('SoloAgent')).toBe('solo_coder');
  });

  it('maps UiBuilder → solo_builder', () => {
    expect(mod.normalizeAgentType('UiBuilder')).toBe('solo_builder');
  });

  it('maps Custom(merge) → solo_coder (split on "(")', () => {
    expect(mod.normalizeAgentType('Custom(merge)')).toBe('solo_coder');
  });

  it('returns null for unknown agent_type', () => {
    expect(mod.normalizeAgentType('Unknown')).toBeNull();
    expect(mod.normalizeAgentType(null)).toBeNull();
    expect(mod.normalizeAgentType(undefined)).toBeNull();
  });
});

describe('Trae-CN pickDefaultModelForAgentType — end-to-end mapper', () => {
  it('agent_type=SoloAgent with solo_agent entry → strips prefix, returns Doubao-Seed-Code', () => {
    buildVscdb([{ key: 'someUserId_AI.agent.model.model_list_map', value: JSON.stringify(CATALOG_SOLO_AGENT_DEFAULT) }]);
    const pick = mod.pickDefaultModelForAgentType('SoloAgent', {});
    expect(pick).not.toBeNull();
    expect(pick.name).toBe('Doubao-Seed-Code');
    // vscdb entry `{ modelId, mode }` has no provider field; picker returns
    // null rather than fabricating one. Provider is resolved separately by
    // resolveProvider.
    expect(pick.provider).toBeNull();
  });

  it('agent_type=Builder with empty entry → falls back to session_selected_model', () => {
    buildVscdb([
      { key: 'AI.agent.model.model_list_map', value: JSON.stringify(CATALOG_BUILDER_EMPTY) },
      { key: 'session_selected_model', value: 'Doubao-Seed-2.1-Turbo' },
    ]);
    const pick = mod.pickDefaultModelForAgentType('Builder', {});
    expect(pick).not.toBeNull();
    expect(pick.name).toBe('Doubao-Seed-2.1-Turbo');
  });

  it('agent_type=Builder empty entry + no session_selected_model → falls back to ai_assistant.request.model config', () => {
    buildVscdb([
      { key: 'AI.agent.model.model_list_map', value: JSON.stringify(CATALOG_BUILDER_EMPTY) },
      { key: 'ai_assistant.request.model', value: 'Qwen-Coder-32B' },
    ]);
    const pick = mod.pickDefaultModelForAgentType('Builder', {});
    expect(pick).not.toBeNull();
    expect(pick.name).toBe('Qwen-Coder-32B');
  });

  it('agent_type=Builder empty entry + all vscdb fallbacks missing → returns null (NO solo_agent heuristic)', () => {
    buildVscdb([{ key: 'AI.agent.model.model_list_map', value: JSON.stringify(CATALOG_BUILDER_EMPTY) }]);
    const pick = mod.pickDefaultModelForAgentType('Builder', {});
    expect(pick).toBeNull();
  });

  it('agent_type unknown → returns null (no heuristic, no fallback to other agent_type buckets)', () => {
    buildVscdb([{ key: 'AI.agent.model.model_list_map', value: JSON.stringify(CATALOG_SOLO_AGENT_DEFAULT) }]);
    const pick = mod.pickDefaultModelForAgentType('MysteryAgent', {});
    // Unknown agent_type → normalizeAgentType returns null → no catalog lookup
    // → falls through to session_selected_model / config which are missing → null.
    expect(pick).toBeNull();
  });
});

// P1-3 modelId extraction from vscdb nested schema. Deployer-confirmed
// schema: { "<user_id>": { "<agent_type>": { modelId, mode, ... } } }.
// modelId carries synthetic prefix `<agent_type>_<N>__` that must be stripped.
describe('Trae-CN pickDefaultModelForAgentType — P1-3 modelId extraction', () => {
  it('deployer sample: raw JSON → extracts Doubao-Seed-Code (prefix stripped)', () => {
    const raw = '{"6af6d570164695484f84f7f1":{"solo_agent":{"modelId":"solo_agent_1__Doubao-Seed-Code","mode":1}}}';
    buildVscdb([{ key: 'AI.agent.model.model_list_map', value: raw }]);
    const pick = mod.pickDefaultModelForAgentType('SoloAgent', {});
    expect(pick).not.toBeNull();
    expect(pick.name).toBe('Doubao-Seed-Code');
    expect(pick.display_name).toBe('Doubao-Seed-Code');
  });

  it('modelId without prefix (e.g. Qwen-Coder-32B) → returned as-is', () => {
    const raw = '{"uid-1":{"solo_agent":{"modelId":"Qwen-Coder-32B","mode":1}}}';
    buildVscdb([{ key: 'AI.agent.model.model_list_map', value: raw }]);
    const pick = mod.pickDefaultModelForAgentType('SoloAgent', {});
    expect(pick).not.toBeNull();
    expect(pick.name).toBe('Qwen-Coder-32B');
  });

  it('JSON parse failure → falls through to session_selected_model / config → null when both missing', () => {
    buildVscdb([{ key: 'AI.agent.model.model_list_map', value: 'not-valid-json{' }]);
    const pick = mod.pickDefaultModelForAgentType('SoloAgent', {});
    expect(pick).toBeNull();
  });

  it('empty catalog object → falls through → null', () => {
    buildVscdb([{ key: 'AI.agent.model.model_list_map', value: '{}' }]);
    const pick = mod.pickDefaultModelForAgentType('SoloAgent', {});
    expect(pick).toBeNull();
  });

  it('multiple user_id keys → picks first one with matching agent_type', () => {
    const raw = '{"uid-a":{"builder":{"modelId":"builder_1__Doubao-Seed-Turbo","mode":1}},'
              + '"uid-b":{"solo_agent":{"modelId":"solo_agent_2__Doubao-Seed-Code","mode":1}}}';
    buildVscdb([{ key: 'AI.agent.model.model_list_map', value: raw }]);
    const pick = mod.pickDefaultModelForAgentType('SoloAgent', {});
    expect(pick).not.toBeNull();
    // Picker iterates Object.keys(catalog) in insertion order — uid-a first,
    // but uid-a has no solo_agent entry, so picker continues to uid-b.
    expect(pick.name).toBe('Doubao-Seed-Code');
  });

  it('stripModelIdPrefix: strips solo_agent_1__ prefix', () => {
    expect(mod.stripModelIdPrefix('solo_agent_1__Doubao-Seed-Code')).toBe('Doubao-Seed-Code');
  });

  it('stripModelIdPrefix: no prefix → returns input unchanged', () => {
    expect(mod.stripModelIdPrefix('Qwen-Coder-32B')).toBe('Qwen-Coder-32B');
  });

  it('stripModelIdPrefix: builder_2__ prefix stripped', () => {
    expect(mod.stripModelIdPrefix('builder_2__Doubao-Seed-Turbo')).toBe('Doubao-Seed-Turbo');
  });

  it('stripModelIdPrefix: non-string → returns null', () => {
    expect(mod.stripModelIdPrefix(null)).toBeNull();
    expect(mod.stripModelIdPrefix(undefined)).toBeNull();
    expect(mod.stripModelIdPrefix(42)).toBeNull();
  });
});
