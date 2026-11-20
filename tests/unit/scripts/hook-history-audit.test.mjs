import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { auditHookHistory } from '../../../scripts/diagnostics/hook-history-audit.mjs';

let root;
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });
it('selects the latest six numeric rotations across day boundaries', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-audit-rotations-'));
  const logs = path.join(root, 'logs');
  await fs.mkdir(logs);
  for (const date of ['2026-11-16', '2026-11-17']) {
    for (let i = 1; i <= 12; i++) {
      await fs.writeFile(path.join(logs, `loongsuite-pilot-service.log.${date}.${i}`),
        JSON.stringify({ tag: 'LogRetention', msg: `${date}.${i}` }) + '\n');
    }
  }
  const result = await auditHookHistory(root);
  expect(result.cleanupLogs.map(row => row.msg)).toEqual(
    Array.from({ length: 6 }, (_, i) => `2026-11-17.${i + 7}`));
});
it('explains file metadata without emitting source bodies or changing source/checkpoint files', async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hook-audit-')));
  const dir = path.join(root, 'logs', 'pi-coding-agent');
  await fs.mkdir(dir, { recursive: true });
  const name = 'pi-coding-agent-2020-01-01.jsonl';
  const source = path.join(dir, name);
  const text = '{"message":"private-source-body-must-never-be-output"}\n';
  await fs.writeFile(source, text);
  const old = new Date('2020-01-01'); await fs.utimes(source, old, old);
  const stat = await fs.stat(source);
  const checkpoint = JSON.stringify({ 'pi-coding-agent-log': { extra: {
    hookLogDir: dir, hookLogPrefix: 'pi-coding-agent', hookLogOffsets: { [name]: stat.size },
    hookLogIdentities: { [name]: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` },
  } } });
  const state = path.join(root, 'logs', 'input-state.json');
  await fs.writeFile(state, checkpoint);
  await fs.writeFile(path.join(root, 'logs', 'loongsuite-pilot-service.log.2026-11-17.1'), [
    JSON.stringify({ tag: 'Input', msg: 'private-source-body-must-never-be-output' }),
    JSON.stringify({ tag: 'LogRetention', msg: 'raw source retention failed', error: 'EPERM', input: 'pi-coding-agent-log' }),
  ].join('\n'));
  const result = await auditHookHistory(root);
  expect(result.readOnly).toBe(true);
  expect(result.families[0].byReason['candidate-needs-live-gate-check']).toEqual({ files: 1, bytes: stat.size });
  expect(result.cleanupLogs).toMatchObject([{ error: 'EPERM' }]);
  expect(JSON.stringify(result)).not.toContain('private-source-body');
  expect(await fs.readFile(source, 'utf8')).toBe(text);
  expect(await fs.readFile(state, 'utf8')).toBe(checkpoint);
  const quarantined = JSON.parse(checkpoint);
  quarantined['pi-coding-agent-log'].extra.hookLogOffsets[name] = 0;
  quarantined['pi-coding-agent-log'].extra.hookLogPartialTails = { [name]: {
    reason: 'closed-incomplete-tail', identity: `${stat.dev}:${stat.ino}${process.platform === 'darwin' || process.platform === 'win32' ? ':' + stat.birthtimeMs : ''}`,
    offset: 0, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
  } };
  await fs.writeFile(state, JSON.stringify(quarantined));
  expect((await auditHookHistory(root)).families[0].byReason['closed-incomplete-tail']).toEqual({ files: 1, bytes: stat.size });
  await fs.appendFile(source, 'changed');
  expect((await auditHookHistory(root)).families[0].byReason['closed-incomplete-tail']).toBeUndefined();
  await fs.writeFile(path.join(root, 'config.json'), 'private-malformed-config-must-never-be-output');
  const malformed = await auditHookHistory(root);
  expect(malformed.retentionConfigError).toBe('invalid-metadata-json');
  expect(JSON.stringify(malformed)).not.toContain('private-malformed-config');
});
