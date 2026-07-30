import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { HookWatchdog, stripMarkerBlock } from '../../../src/core/hook-watchdog.js';

// Real-shell regression guard for the rc intercept block.
//
// Unlike hook-watchdog-intercept.test.ts (which mocks node:child_process and
// only asserts the block text), this file does NOT mock child_process: it
// renders the ACTUAL block the watchdog/installer write — via the pure
// HookWatchdog.interceptRcBlockDefs() seam — and sources it in bash AND zsh to
// prove the block is parse-safe under an active user alias (the reported bug)
// and does not clobber the user's own alias/function.
//
// Using the pure seam (not repair()) avoids touching HOME/fs — important
// because under vitest os.homedir() ignores a runtime process.env.HOME change,
// which would otherwise risk writing into the developer's real rc files.

function shellAvailable(sh: string): boolean {
  try {
    execFileSync(sh, ['-c', 'exit 0'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function blockFor(id: string): string {
  const def = HookWatchdog.interceptRcBlockDefs().find(d => d.id === id);
  if (!def) throw new Error(`no rc block def for ${id}`);
  return def.blockFn(`/tmp/pilot-hooks/${def.scriptName}`);
}

function sourceInBash(script: string): string {
  // shopt -s expand_aliases makes non-interactive bash expand aliases, matching
  // the interactive rc-sourcing behavior where the parse-time collision occurs.
  return execFileSync('bash', ['-c', `shopt -s expand_aliases\n${script}`], { encoding: 'utf-8' });
}

function sourceInZsh(script: string): string {
  return execFileSync('zsh', ['-c', script], { encoding: 'utf-8' });
}

const CLAUDE_ALIAS =
  "alias claude='all_proxy=http://127.0.0.1:7899 /usr/local/bin/claude --dangerously-skip-permissions'";
// Fake `command` so we can observe what the wrapper would forward, with no real CLI.
const PROBE = 'command() { echo "WRAP_RAN BUN_OPTIONS=$BUN_OPTIONS args=[$*]"; }';

const HAS_BASH = shellAvailable('bash');
const HAS_ZSH = shellAvailable('zsh');

describe('rc intercept block sources safely in real shells', () => {
  describe.skipIf(!HAS_BASH)('bash', () => {
    it('sources cleanly under an active claude alias and does not clobber it', () => {
      const block = blockFor('claude-code-rc');
      const out = sourceInBash(`${CLAUDE_ALIAS}\n${block}\necho SRC_OK\nalias claude`);
      expect(out).toContain('SRC_OK'); // no syntax error → reached echo
      expect(out).toContain('dangerously-skip-permissions'); // user alias preserved
      expect(out).not.toContain('WRAP_RAN'); // our wrapper did not shadow the alias
    });

    it('defines the wrapper and composes BUN_OPTIONS when no alias exists', () => {
      const block = blockFor('claude-code-rc');
      const out = sourceInBash(
        `export BUN_OPTIONS='--preload=/user/own.mjs'\n${block}\n${PROBE}\nclaude hello`,
      );
      expect(out).toContain('WRAP_RAN');
      expect(out).toContain('claude-code-fetch-intercept.mjs'); // our preload injected
      expect(out).toContain('/user/own.mjs'); // user's existing BUN_OPTIONS preserved
      expect(out).toContain('args=[claude hello]'); // `command claude "$@"` forwards args
    });

    it('does not clobber a user-defined claude function', () => {
      const block = blockFor('claude-code-rc');
      const out = sourceInBash(`claude() { echo USER_FN; }\n${block}\nclaude`);
      expect(out).toContain('USER_FN');
    });

    it('is idempotent across a double source', () => {
      const block = blockFor('claude-code-rc');
      const out = sourceInBash(`${block}\n${block}\n${PROBE}\nclaude x\necho DONE`);
      expect(out).toContain('DONE');
      expect(out).toContain('WRAP_RAN');
    });
  });

  describe.skipIf(!HAS_ZSH)('zsh', () => {
    it('sources cleanly under an active claude alias and does not clobber it', () => {
      const block = blockFor('claude-code-rc');
      const out = sourceInZsh(`${CLAUDE_ALIAS}\n${block}\necho SRC_OK\nwhich claude`);
      expect(out).toContain('SRC_OK');
      expect(out).toContain('dangerously-skip-permissions');
      expect(out).not.toContain('WRAP_RAN');
    });

    it('defines the wrapper and composes BUN_OPTIONS when no alias exists', () => {
      const block = blockFor('claude-code-rc');
      const out = sourceInZsh(
        `export BUN_OPTIONS='--preload=/user/own.mjs'\n${block}\n${PROBE}\nclaude hello`,
      );
      expect(out).toContain('WRAP_RAN');
      expect(out).toContain('/user/own.mjs');
      expect(out).toContain('args=[claude hello]');
    });
  });

  describe.skipIf(!HAS_BASH)('qodercli block (bash)', () => {
    it('sources cleanly under an active qodercli alias and preserves it', () => {
      const block = blockFor('qodercli-rc');
      const out = sourceInBash(
        `alias qodercli='qodercli --foo'\n${block}\necho SRC_OK\nalias qodercli`,
      );
      expect(out).toContain('SRC_OK');
      expect(out).toContain('qodercli --foo'); // user alias preserved
    });
  });

  // The reported bug's real-world path: a user who installed an OLD release
  // already has a bare `claude() {...}` block (same marker) in their rc AND a
  // claude alias — so their rc parse-errors today. Simulate repair()'s
  // migration (stripMarkerBlock + append current block) and prove the result
  // sources cleanly, with the old bare block gone.
  describe.skipIf(!HAS_BASH)('migration of an old bare-function block (bash)', () => {
    const def = HookWatchdog.interceptRcBlockDefs().find(d => d.id === 'claude-code-rc')!;
    const OLD_BARE_BLOCK = [
      '# loongsuite-pilot BEGIN claude-code-intercept',
      'claude() { BUN_OPTIONS="--preload=/old/path ${BUN_OPTIONS}" command claude "$@"; }',
      '# loongsuite-pilot END claude-code-intercept',
    ].join('\n');

    it('old bare block under an alias fails to source (documents the bug)', () => {
      let errored = false;
      try {
        sourceInBash(`${CLAUDE_ALIAS}\n${OLD_BARE_BLOCK}\necho SHOULD_NOT_REACH`);
      } catch {
        errored = true; // non-zero exit → parse error
      }
      expect(errored).toBe(true);
    });

    it('after migration the rc sources cleanly and the bare block is gone', () => {
      const rc = `${CLAUDE_ALIAS}\n\n${OLD_BARE_BLOCK}\n`;
      // What repair() does for a stale block:
      const migrated =
        stripMarkerBlock(rc, def.marker, def.endMarker).replace(/\n+$/, '\n') +
        def.blockFn('/tmp/pilot-hooks/claude-code-fetch-intercept.mjs') + '\n';

      expect(migrated).not.toMatch(/^claude\(\) \{/m); // old bare block removed
      expect(migrated).toContain(def.signature);       // new guarded block present

      const out = sourceInBash(`${migrated}\necho SRC_OK\nalias claude`);
      expect(out).toContain('SRC_OK');                 // no syntax error
      expect(out).toContain('dangerously-skip-permissions'); // user alias preserved
    });
  });
});
