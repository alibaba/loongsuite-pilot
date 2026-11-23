// POSIX-mode parse guard for the hook shell scripts.
//
// The hooks carry a `#!/usr/bin/env bash` shebang, but agents do not always honour
// it — some invoke the hook through `sh <script>` or an `sh -c` wrapper. On macOS
// /bin/sh is bash in POSIX mode, which parses `[[ ]]`, `=~` and `<<<` but *rejects*
// process substitution. A `done < <(...)` in the node fallback therefore made every
// hook die with "syntax error near unexpected token `<'" before doing any work.
//
// These tests parse each shipped hook under both plain bash and bash --posix so that
// class of breakage cannot reach users again.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const HOOK_DIR = 'assets/hooks';
const HOOKS = readdirSync(resolve(HOOK_DIR))
  .filter(f => f.endsWith('.sh'))
  .sort();

// Sanity check: the list is discovered, so a new hook is covered automatically.
it('discovers the hook scripts to check', () => {
  expect(HOOKS.length).toBeGreaterThanOrEqual(9);
});

describe.each(HOOKS)('%s', (hook) => {
  const path = resolve(HOOK_DIR, hook);

  it('parses under bash', () => {
    const r = spawnSync('bash', ['-n', path], { encoding: 'utf-8' });
    expect(r.stderr.trim(), r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('parses under bash --posix (how /bin/sh runs it)', () => {
    const r = spawnSync('bash', ['--posix', '-n', path], { encoding: 'utf-8' });
    expect(r.stderr.trim(), r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('uses no process substitution', () => {
    // Comments may mention the construct; only real code is a problem, and any real
    // occurrence would already fail the --posix parse above. This keeps the intent
    // explicit and the failure message obvious.
    const code = readFileSync(path, 'utf-8')
      .split('\n')
      .filter(l => !l.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/<\s*\(/);
    expect(code).not.toMatch(/>\s*\(/);
  });
});
