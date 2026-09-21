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
