import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonlRecords } from '../../../../assets/hooks/shared/event-emitter.mjs';
import { filterWorkspaceRecords } from '../../../../assets/hooks/shared/workspace-privacy.mjs';
let root;
afterEach(() => { vi.unstubAllEnvs(); if (root) fs.rmSync(root, { recursive: true, force: true }); });
it('drops excluded content before creating hook history and shares persistent decisions', () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-privacy-'));
  vi.stubEnv('LOONGSUITE_PILOT_DATA_DIR', root);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ privacy: { excludeWorkspaces: [path.join(root, 'private')] } }));
  const record = { 'gen_ai.session.id': 'secret-session', 'gen_ai.agent.type': 'claude-code', cwd: path.join(root, 'private'), content: 'secret-text' };
  const logDir = path.join(root, 'history');
  writeJsonlRecords(logDir, 'claude-code', [record]);
  expect(fs.existsSync(logDir)).toBe(false);
  expect(filterWorkspaceRecords([{ ...record, cwd: '/public' }], 'claude-code')).toEqual([]);
  expect(filterWorkspaceRecords([{ 'gen_ai.session.id': 'unknown' }], 'claude-code')).toHaveLength(1);
});

function configFixture(value) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-privacy-'));
  vi.stubEnv('LOONGSUITE_PILOT_DATA_DIR', root);
  vi.stubEnv('AGENT_DATA_COLLECTION_CONFIG', path.join(root, 'config.json'));
  fs.writeFileSync(path.join(root, 'config.json'), value);
  return path.join(root, 'history');
}
const publicRecord = { 'gen_ai.session.id': 'public-session', 'gen_ai.agent.type': 'qoder', cwd: '/public-project', content: 'public-content' };

it('accepts UTF-8 BOM configuration written by Windows editors', () => {
  const history = configFixture('\uFEFF' + JSON.stringify({ privacy: { excludeWorkspaces: ['/private-project'] } }));
  writeJsonlRecords(history, 'qoder', [publicRecord]);
  expect(fs.readdirSync(history)).toHaveLength(1);
});

it.each(['{"privacy":', ...[['relative'], [null], 'not-an-array'].map(excludeWorkspaces => JSON.stringify({ privacy: { excludeWorkspaces } }))])(
  'reports failed policy loading without consuming the transcript, then retries after repair: %s', async (invalid) => {
    const history = configFixture(invalid);
    vi.resetModules();
    const { appendRowsToHistory, updateLineRecord, loadLineRecord } = await import('../../../../assets/hooks/shared/hook-processor-base.mjs');
    const rows = [JSON.stringify(publicRecord)];
    expect(() => writeJsonlRecords(history, 'qoder', [publicRecord])).toThrow(/workspace privacy/i);
    // The real Qoder caller only commits its cursor after this writer returns true.
    const before = loadLineRecord('qoder', 'public-session');
    const attempt = appendRowsToHistory('qoder', 'qoder', rows);
    expect(attempt).toBe(false);
    if (attempt) updateLineRecord('qoder', '/fixture/transcript.jsonl', 'public-session', 20);
    expect(loadLineRecord('qoder', 'public-session')).toEqual(before);
    expect(fs.existsSync(history)).toBe(false);
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ privacy: { excludeWorkspaces: ['/private-project'] } }));
    expect(appendRowsToHistory('qoder', 'qoder', rows)).toBe(true);
  },
);

it('treats config read errors as retryable failures, not an empty successful batch', () => {
  const history = configFixture('{}');
  fs.unlinkSync(path.join(root, 'config.json'));
  fs.mkdirSync(path.join(root, 'config.json'));
  expect(() => writeJsonlRecords(history, 'qoder', [publicRecord])).toThrow(/workspace privacy/i);
  expect(fs.existsSync(history)).toBe(false);
});

it('keeps an in-memory session exclusion between hook writes when persistence fails', () => {
  configFixture(JSON.stringify({ privacy: { excludeWorkspaces: ['/private-project'] } }));
  const warning = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    fs.writeFileSync(path.join(root, 'state'), 'pre-existing file');
    const privateRecord = { ...publicRecord, cwd: '/private-project' };
    expect(filterWorkspaceRecords([privateRecord], 'qoder')).toEqual([]);
    expect(filterWorkspaceRecords([{ ...publicRecord, cwd: undefined }], 'qoder')).toEqual([]);
    expect(filterWorkspaceRecords([{ ...publicRecord, 'gen_ai.session.id': 'another' }], 'qoder')).toHaveLength(1);
    expect(warning).toHaveBeenCalledOnce();
  } finally { warning.mockRestore(); }
});
