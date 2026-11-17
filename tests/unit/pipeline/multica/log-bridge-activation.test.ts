import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { isCollectionActive, readActivationPermit } from '../../../../scripts/multica-log-bridge.mjs';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'multica-bridge-activation-')); });
afterEach(async () => { await rm(dir, {recursive: true, force: true}); });

describe('Multica log bridge activation lease', () => {
  const now = 1_700_000_000_000;
  const active = {enabled: true, mode: 'on', stopped: false, expiresAt: now + 1000};

  it('accepts only a complete, enabled, unexpired collection lease', () => {
    expect(isCollectionActive(active, now)).toBe(true);
    for (const value of [
      undefined, null, [], true, {},
      {...active, enabled: false}, {...active, enabled: 'true'},
      {...active, mode: 'off'}, {...active, stopped: true},
      {...active, stopped: undefined}, {...active, expiresAt: now},
      {...active, expiresAt: now - 1}, {...active, expiresAt: String(now + 1000)},
      {...active, expiresAt: Infinity}, {...active, expiresAt: NaN},
    ]) expect(isCollectionActive(value, now)).toBe(false);
  });

  it('fails closed for missing, malformed, oversized and expired local state', async () => {
    const file = join(dir, 'activation.json');
    expect(await readActivationPermit(undefined, now)).toBe(false);
    expect(await readActivationPermit(file, now)).toBe(false);
    expect(await readActivationPermit(dir, now)).toBe(false);
    for (const text of ['{', '{}', '[]', 'x'.repeat(4097), JSON.stringify({...active, expiresAt: now})]) {
      await writeFile(file, text);
      expect(await readActivationPermit(file, now)).toBe(false);
    }
    await writeFile(file, JSON.stringify(active));
    expect(await readActivationPermit(file, now)).toBe(true);
    await writeFile(file, JSON.stringify({...active, enabled: false}));
    expect(await readActivationPermit(file, now)).toBe(false);
  });

  it.each(['missing', 'off', 'expired', 'unscoped'])('stays idle with %s state without loading absent Kubernetes credentials or creating a log spool', async state => {
    const file = join(dir, 'activation.json');
    if (state !== 'missing') await writeFile(file, JSON.stringify({
      enabled: state !== 'off', mode: state === 'off' ? 'off' : 'on', stopped: false,
      expiresAt: state === 'expired' ? Date.now() - 1 : Date.now() + 60_000,
    }));
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../../../scripts/multica-log-bridge.mjs', import.meta.url))], {
      env: {...process.env, MULTICA_ACTIVATION_STATE_FILE: file,
        NAMESPACE: 'test-namespace', POD_LABEL_SELECTOR: '',
        LOG_DIRECTORY: join(dir, 'not-created'), KUBE_CREDENTIAL_DIRECTORY: join(dir, 'missing-credentials')},
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errors = '';
    child.stderr.on('data', chunk => { errors += String(chunk); });
    const completed = new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
    try {
      if (state === 'unscoped') {
        // Wait for the child to start even under parallel test-worker load.
        await vi.waitFor(() => expect(errors).toContain('NAMESPACE and POD_LABEL_SELECTOR are required'), {timeout: 2000});
      } else await delay(250);
      expect(child.exitCode).toBe(null);
      if (state === 'unscoped') expect(errors).toContain('NAMESPACE and POD_LABEL_SELECTOR are required');
      else expect(errors).toBe('');
      expect(await readdir(dir)).toEqual(state === 'missing' ? [] : ['activation.json']);
    } finally {
      child.kill('SIGKILL');
      await completed;
    }
  });
});
