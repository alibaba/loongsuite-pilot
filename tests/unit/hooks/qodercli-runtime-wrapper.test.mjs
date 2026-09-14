import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(__dirname, '../../../assets/hooks');
const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function makeFixture(qodercliSource, withIntercept = true, qodercliName = 'qodercli') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-qoder-wrapper-'));
  tempDirs.push(root);
  const hooks = path.join(root, 'hooks');
  const bin = path.join(root, 'bin');
  await fs.mkdir(hooks, { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.copyFile(
    path.join(ASSETS, 'qodercli-runtime-wrapper.sh'),
    path.join(hooks, 'qodercli-runtime-wrapper.sh'),
  );
  if (withIntercept) {
    await fs.writeFile(path.join(hooks, 'qodercli-token-intercept.mjs'), 'export {};\n');
  }
  const qodercli = path.join(bin, qodercliName);
  await fs.writeFile(qodercli, qodercliSource, { mode: 0o755 });
  return {
    root,
    wrapper: path.join(hooks, 'qodercli-runtime-wrapper.sh'),
    bin,
    qodercli,
  };
}

/** Add another executable to an existing fixture's bin dir. */
async function addBin(fixture, name, source) {
  const p = path.join(fixture.bin, name);
  await fs.writeFile(p, source, { mode: 0o755 });
  return p;
}

/**
 * A launcher that reports which entry actually ran plus the intercept file the
 * wrapper picked. `id` is what tells the two product lines' entries apart.
 */
const probe = (id) => `#!/bin/sh
printf '{"id":"${id}","interceptFile":"%s","nodeOptions":"%s","bunOptions":"%s"}\\n' "$LOONGSUITE_INTERCEPT_FILE" "$NODE_OPTIONS" "$BUN_OPTIONS"
`;

// A PATH with the usual utilities (the wrapper shells out to tr/head/grep) but
// no CLI of either flavor, so only an explicit override can resolve an entry.
const BARE_PATH = '/usr/bin:/bin';

describe('qodercli runtime wrapper', () => {
  it('uses NODE_OPTIONS --import for a Node shebang and preserves user options', async () => {
    const fixture = await makeFixture(`#!/usr/bin/env node
console.log(JSON.stringify({
  nodeOptions: process.env.NODE_OPTIONS,
  bunOptions: process.env.BUN_OPTIONS || '',
  args: process.argv.slice(2)
}));
`);
    const result = spawnSync('sh', [fixture.wrapper, 'hello'], {
      env: {
        ...process.env,
        PATH: `${fixture.bin}:${process.env.PATH}`,
        NODE_OPTIONS: '--trace-warnings',
        BUN_OPTIONS: '',
      },
      encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.nodeOptions).toContain('--import=');
    expect(output.nodeOptions).toContain('qodercli-token-intercept.mjs');
    expect(output.nodeOptions).toContain('--trace-warnings');
    expect(output.bunOptions).toBe('');
    expect(output.args).toEqual(['hello']);
  });

  it('uses BUN_OPTIONS --preload for a native/non-Node launcher', async () => {
    const fixture = await makeFixture(`#!/bin/sh
printf '{"nodeOptions":"%s","bunOptions":"%s","arg":"%s"}\\n' "$NODE_OPTIONS" "$BUN_OPTIONS" "$1"
`);
    const result = spawnSync('sh', [fixture.wrapper, 'hello'], {
      env: {
        ...process.env,
        PATH: `${fixture.bin}:${process.env.PATH}`,
        NODE_OPTIONS: '',
        BUN_OPTIONS: '--preload=/user/own.mjs',
      },
      encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.nodeOptions).toBe('');
    expect(output.bunOptions).toContain('qodercli-token-intercept.mjs');
    expect(output.bunOptions).toContain('/user/own.mjs');
    expect(output.arg).toBe('hello');
  });

  it('runs a bundled SDK .mjs entry through Node without requiring a shebang', async () => {
    const fixture = await makeFixture(`
console.log(JSON.stringify({
  nodeOptions: process.env.NODE_OPTIONS,
  bunOptions: process.env.BUN_OPTIONS || '',
  args: process.argv.slice(2)
}));
`, true, 'qoder-worker-runtime.obf.mjs');
    const result = spawnSync('sh', [fixture.wrapper, 'hello'], {
      env: {
        ...process.env,
        LOONGSUITE_QODERCLI_BIN: fixture.qodercli,
        NODE_OPTIONS: '',
        BUN_OPTIONS: '',
      },
      encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.nodeOptions).toContain('--import=');
    expect(output.nodeOptions).toContain('qodercli-token-intercept.mjs');
    expect(output.bunOptions).toBe('');
    expect(output.args).toEqual(['hello']);
  });

  it('routes a shebang-less entry reached through PATH to Node', async () => {
    // The real install puts a link on PATH whose name carries no extension
    // (~/.local/bin/qodercli -> .../qodercli-1.1.42), so the extension arm never
    // fires and classification falls through to the file header. A bundled entry
    // has no shebang, and the header check read that absence as "then it is Bun":
    // the entry got exec'd directly, the kernel refused a JS text file, and the
    // shell then tried to run JS as a shell script. The CLI did not start at all.
    // The .mjs test above passes LOONGSUITE_QODERCLI_BIN with the extension still
    // on it, so it settles on the extension arm and never reaches this one.
    const fixture = await makeFixture(`
console.log(JSON.stringify({
  nodeOptions: process.env.NODE_OPTIONS,
  bunOptions: process.env.BUN_OPTIONS || '',
  args: process.argv.slice(2)
}));
`, true, 'entry.mjs');
    // The name command -v resolves carries no extension, unlike its target.
    await fs.symlink(fixture.qodercli, path.join(fixture.bin, 'qodercli'));
    const result = spawnSync('sh', [fixture.wrapper, 'hello'], {
      env: {
        ...process.env,
        // No _BIN, so resolution goes through PATH. The full PATH stays on so
        // the Node the wrapper falls back to is reachable; fixture.bin comes
        // first, so the entry resolved is this test's.
        PATH: `${fixture.bin}:${process.env.PATH}`,
        NODE_OPTIONS: '',
        BUN_OPTIONS: '',
      },
      encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.nodeOptions).toContain('--import=');
    expect(output.nodeOptions).toContain('qodercli-token-intercept.mjs');
    expect(output.bunOptions).toBe('');
    expect(output.args).toEqual(['hello']);
  });

  it('does not hand a compiled entry reached through PATH to Node', async () => {
    // Counterpart to the test above: the Node arm must not widen into compiled
    // entries, because `exec node <binary>` fails outright and would trade one
    // startup failure for another. A Mach-O header followed by NUL bytes is
    // enough to exercise the classification -- the file never has to be
    // loadable, and copying a real system binary is not portable here anyway.
    // A stub named `node` on PATH is what would report having been used.
    const fixture = await makeFixture('unused\n', true, 'placeholder');
    await fs.writeFile(
      path.join(fixture.bin, 'qodercli'),
      Buffer.from([0xcf, 0xfa, 0xed, 0xfe, ...new Array(28).fill(0)]),
      { mode: 0o755 },
    );
    await addBin(fixture, 'node', '#!/bin/sh\necho NODE_TOOK_IT\n');
    const result = spawnSync('sh', [fixture.wrapper, 'hello'], {
      env: {
        ...process.env,
        PATH: `${fixture.bin}:${BARE_PATH}`,
        NODE_OPTIONS: '',
        BUN_OPTIONS: '',
      },
      encoding: 'utf-8',
    });
    // The entry resolved, so this is really the classification talking and not
    // an early bail-out with an empty stdout.
    expect(result.stderr).not.toContain('executable not found');
    expect(result.stdout).not.toContain('NODE_TOOK_IT');
  });

  it('leaves an entry whose bytes cannot be read on the previous path', async () => {
    // "No shebang and no NUL byte" must mean bytes were read and looked like
    // text, not that reading produced nothing. Reading can come up empty for a
    // binary too -- a distribution that ships mode 111, for instance -- and
    // routing that to Node turns a CLI that starts today into one that does not.
    // An empty file stands in for the whole class here because it needs no
    // permission trick, which would be a no-op for a root test runner.
    const fixture = await makeFixture('unused\n', true, 'placeholder');
    await fs.writeFile(path.join(fixture.bin, 'qodercli'), '', { mode: 0o755 });
    await addBin(fixture, 'node', '#!/bin/sh\necho NODE_TOOK_IT\n');
    const result = spawnSync('sh', [fixture.wrapper, 'hello'], {
      env: {
        ...process.env,
        PATH: `${fixture.bin}:${BARE_PATH}`,
        NODE_OPTIONS: '',
        BUN_OPTIONS: '',
      },
      encoding: 'utf-8',
    });
    expect(result.stderr).not.toContain('executable not found');
    expect(result.stdout).not.toContain('NODE_TOOK_IT');
  });

  it('scopes the intercept file to the qoderclicn flavor', async () => {
    // The CN rc block launches this same wrapper with LOONGSUITE_QODERCLI_FLAVOR
    // set; the derived intercept file name is the only thing keeping the two
    // product lines' token output apart. Nothing asserted that name before, so
    // both lines could have been writing to one file unnoticed.
    const fixture = await makeFixture(probe('CN'), true, 'qoderclicn');
    const result = spawnSync('sh', [fixture.wrapper, 'hello'], {
      env: {
        ...process.env,
        LOONGSUITE_QODERCLI_FLAVOR: 'qoderclicn',
        PATH: `${fixture.bin}:${BARE_PATH}`,
        NODE_OPTIONS: '',
        BUN_OPTIONS: '',
      },
      encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.id).toBe('CN'); // resolved `qoderclicn` off PATH, not `qodercli`
    expect(output.interceptFile).toBe('qoderclicn-intercept.jsonl');
    expect(output.bunOptions).toContain('qodercli-token-intercept.mjs'); // one shared asset
  });

  it('keeps the default flavor writing to the qodercli intercept file', async () => {
    // Counterpart to the CN case: proves the name is derived from the flavor
    // rather than hard-coded on either side.
    const fixture = await makeFixture(probe('INTL'));
    const result = spawnSync('sh', [fixture.wrapper], {
      env: {
        ...process.env,
        PATH: `${fixture.bin}:${BARE_PATH}`,
        NODE_OPTIONS: '',
        BUN_OPTIONS: '',
      },
      encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim()).interceptFile).toBe('qodercli-intercept.jsonl');
  });

  it('does not let the qodercli entry override redirect the qoderclicn flavor', async () => {
    // The wrapper's contract: "The names are per flavor on purpose: a value
    // exported for one product line must not redirect the other." A user with
    // LOONGSUITE_QODERCLI_BIN exported for the international CLI must still get
    // the CN entry when running qoderclicn.
    const fixture = await makeFixture(probe('INTL'), true, 'qodercli');
    await addBin(fixture, 'qoderclicn', probe('CN'));
    const result = spawnSync('sh', [fixture.wrapper], {
      env: {
        ...process.env,
        LOONGSUITE_QODERCLI_FLAVOR: 'qoderclicn',
        LOONGSUITE_QODERCLI_BIN: fixture.qodercli, // the OTHER line's override
        PATH: `${fixture.bin}:${BARE_PATH}`,
        NODE_OPTIONS: '',
        BUN_OPTIONS: '',
      },
      encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.id).toBe('CN'); // international override stayed inert
    expect(output.interceptFile).toBe('qoderclicn-intercept.jsonl');
  });

  it('honours the per-flavor LOONGSUITE_QODERCLICN_BIN override', async () => {
    // The flavor-derived override name has to actually work, or the CN line
    // would have no way to point at a non-PATH entry.
    const fixture = await makeFixture(probe('INTL'), true, 'qodercli');
    const cnBin = await addBin(fixture, 'cn-entry', probe('CN'));
    const result = spawnSync('sh', [fixture.wrapper], {
      env: {
        ...process.env,
        LOONGSUITE_QODERCLI_FLAVOR: 'qoderclicn',
        LOONGSUITE_QODERCLICN_BIN: cnBin,
        PATH: BARE_PATH, // nothing named qoderclicn is reachable
        NODE_OPTIONS: '',
        BUN_OPTIONS: '',
      },
      encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim()).id).toBe('CN');
  });

  it('lets LOONGSUITE_INTERCEPT_FILE override the derived name', async () => {
    const fixture = await makeFixture(probe('CN'), true, 'qoderclicn');
    const result = spawnSync('sh', [fixture.wrapper], {
      env: {
        ...process.env,
        LOONGSUITE_QODERCLI_FLAVOR: 'qoderclicn',
        LOONGSUITE_INTERCEPT_FILE: 'custom-intercept.jsonl',
        PATH: `${fixture.bin}:${BARE_PATH}`,
        NODE_OPTIONS: '',
        BUN_OPTIONS: '',
      },
      encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim()).interceptFile).toBe('custom-intercept.jsonl');
  });

  it('names the missing executable by flavor when nothing resolves', async () => {
    const fixture = await makeFixture(probe('INTL'), true, 'qodercli');
    const result = spawnSync('sh', [fixture.wrapper], {
      env: {
        ...process.env,
        LOONGSUITE_QODERCLI_FLAVOR: 'qoderclicn',
        PATH: BARE_PATH,
        NODE_OPTIONS: '',
        BUN_OPTIONS: '',
      },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(127);
    expect(result.stderr).toContain('qoderclicn executable not found');
  });

  it('fails open when the intercept asset is missing', async () => {
    const fixture = await makeFixture(`#!/bin/sh
printf 'QODER_OK:%s\\n' "$1"
`, false);
    const result = spawnSync('sh', [fixture.wrapper, 'hello'], {
      env: {
        ...process.env,
        PATH: `${fixture.bin}:${process.env.PATH}`,
        NODE_OPTIONS: '',
        BUN_OPTIONS: '',
      },
      encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('QODER_OK:hello');
  });
});
