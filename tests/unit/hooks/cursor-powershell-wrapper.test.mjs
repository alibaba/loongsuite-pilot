import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it } from 'vitest';

const powershell = process.env.PILOT_TEST_PWSH
  || (process.platform === 'win32' ? 'powershell.exe' : undefined);

it.runIf(Boolean(powershell))('passes Cursor stdin and follows managed Node pin rotation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-powershell-'));
  try {
    const home = path.join(root, 'home');
    const dataDir = path.join(root, "data [采集] $runtime O'Brien O’Brien `literal`");
    const cacheDir = path.join(root, 'cache [运行]');
    const hooks = path.join(dataDir, 'hooks');
    await fs.mkdir(path.join(hooks, 'shared'), { recursive: true });
    const launcher = path.join(hooks, 'cursor-loongsuite-pilot-hook.ps1');
    await fs.copyFile('assets/hooks/cursor-loongsuite-pilot-hook.ps1', launcher);
    await fs.copyFile('assets/hooks/shared/common.ps1', path.join(hooks, 'shared', 'common.ps1'));
    await fs.writeFile(path.join(hooks, 'cursor-hook-processor.mjs'), `
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const encode = text => Buffer.from(text).toString('base64');
      console.log(JSON.stringify({
        stdin: Buffer.concat(chunks).toString('base64'),
        data: encode(process.env.LOONGSUITE_PILOT_DATA_DIR),
        runtime: encode(process.env.PILOT_TEST_MANAGED_BIN || process.execPath),
      }));
    `);

    const runtimes = [
      path.join(cacheDir, 'runtime', 'node-v20.5.1-win-x64', 'node.exe'),
      path.join(cacheDir, 'runtime', 'node-v22.22.2', 'bin', 'node.exe'),
    ];
    for (const runtime of runtimes) {
      await fs.mkdir(path.dirname(runtime), { recursive: true });
      if (process.platform === 'win32') {
        await fs.link(process.execPath, runtime).catch(() => fs.copyFile(process.execPath, runtime));
      } else {
        // PowerShell Core on POSIX can also run this stub. A managed pin must
        // resolve without probing --version, even if the probe would fail.
        await fs.writeFile(runtime, [
          '#!/bin/sh',
          'if [ "$1" = "--version" ]; then exit 79; fi',
          'export PILOT_TEST_MANAGED_BIN="$0"',
          'exec "$PILOT_TEST_NODE" "$@"',
        ].join('\n'), { mode: 0o755 });
      }
    }

    const pinFile = path.join(cacheDir, 'node-bin');
    const input = Buffer.from('{"prompt":"中文输入 [test]"}');
    const env = {
      ...process.env,
      USERPROFILE: home,
      LOONGSUITE_PILOT_DATA_DIR: '',
      LOONGSUITE_PILOT_CACHE_DIR: cacheDir,
      PILOT_TEST_NODE: process.execPath,
    };
    const scriptArgument = `'${launcher.replace(/['\u2018\u2019\u201a\u201b]/g, quote => quote + quote)}'`;
    const command = process.platform === 'win32'
      ? `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${scriptArgument}`
      : `& '${powershell}' -NoProfile -NonInteractive -File ${scriptArgument}`;
    const checkRuntime = expected => {
      const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
        input, env, timeout: 15_000, encoding: 'utf8', windowsHide: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      const actual = JSON.parse(result.stdout);
      expect(actual.stdin).toBe(input.toString('base64'));
      expect(Buffer.from(actual.data, 'base64').toString('utf8')).toBe(dataDir);
      expect(Buffer.from(actual.runtime, 'base64').toString('utf8')).toBe(expected);
    };

    for (const runtime of runtimes) {
      await fs.writeFile(pinFile, `\uFEFF${runtime}\r\n`);
      checkRuntime(runtime);
    }
    await fs.unlink(pinFile);
    checkRuntime(runtimes[1]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 45_000);
