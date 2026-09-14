import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

describe.skipIf(!HAS_BASH)('installer CN runtime selection (temporary HOME, mocked launchctl)', () => {
  const installer = readFileSync(new URL('../../../deploy/installer-opensource.sh', import.meta.url), 'utf8');
  // Isolate function execution and app probes from the real installer and host applications.
  const functions = ['inject_qoderwork_runtime_wrapper', 'remove_qoderwork_runtime_wrapper']
    .map(name => {
      const match = installer.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
      if (!match) throw new Error(`Missing installer function: ${name}`);
      return match[0].replaceAll('"/Applications/', '"$HOME/system-apps/');
    }).join('\n');
  let home: string;
  let dataDir: string;
  let wrapper: string;

  function plist(id: string): string {
    return join(home, 'Library', 'LaunchAgents', `com.loongsuite-pilot.${id}.plist`);
  }

  function app(name: string) {
    mkdirSync(join(home, 'Applications', name), { recursive: true });
  }

  function runInstaller(selection: string, qoder = '', qwen = '') {
    execFileSync('bash', ['--noprofile', '--norc', '-c', `
set -euo pipefail
uname() { printf '%s\\n' Darwin; }
msg() { :; }
launchctl() {
  printf '%s|%s|%s\\n' "$1" "$2" "\${3-}" >> "$HOME/launchctl.calls"
  case "$1" in
    getenv) local key="$2"; printf '%s\\n' "\${!key}" ;;
    setenv) printf -v "$2" '%s' "$3" ;;
    unsetenv) printf -v "$2" '%s' '' ;;
    load|unload) [[ "$2" == "$HOME/Library/LaunchAgents/"* ]] ;;
    *) return 99 ;;
  esac
}
${functions}
inject_qoderwork_runtime_wrapper
printf '%s' "$QODER_WORKER_RUNTIME_PATH" > "$HOME/qoder.env"
printf '%s' "$QW_QODER_WORKER_RUNTIME_PATH" > "$HOME/qwen.env"
`], {
      encoding: 'utf8',
      env: {
        ...process.env, HOME: home, BASH_ENV: '', DATA_DIR: dataDir,
        SELECTED_AGENTS: selection,
        QODER_WORKER_RUNTIME_PATH: qoder,
        QW_QODER_WORKER_RUNTIME_PATH: qwen,
      },
    });
    return {
      qoder: readFileSync(join(home, 'qoder.env'), 'utf8'),
      qwen: readFileSync(join(home, 'qwen.env'), 'utf8'),
      calls: readFileSync(join(home, 'launchctl.calls'), 'utf8'),
    };
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'installer-runtime-'));
    dataDir = join(home, 'custom data');
    wrapper = join(dataDir, 'hooks', 'qoderwork-runtime-wrapper.mjs');
    mkdirSync(join(dataDir, 'hooks'), { recursive: true });
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(wrapper, '// shared runtime wrapper\n');
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it.each(['qoder-work', 'qoder-work-cn', 'not-qwen-work-cn'])('does not inject for non-Qwen selection %s', selection => {
    app('QoderWork.app');
    app('QoderWorkCN.app'); // An installed CN app must not resurrect the retired env.
    const result = runInstaller(selection);
    expect(result.qoder).toBe('');
    expect(result.calls).not.toContain('setenv|');
    expect(existsSync(plist('qoderwork-env'))).toBe(false);
  });

  it.each([
    ['qoder-work-cn', 'QoderWork CN.app'],
    ['qoder-work-cn', 'QoderWorkCN.app'],
    ['qoder-work,qoder-work-cn', 'QoderWorkCN.app'],
  ])('retires the legacy env for %s with %s installed', (selection, appName) => {
    app(appName);
    writeFileSync(plist('qoderwork-env'), 'legacy Pilot plist');
    const result = runInstaller(selection, wrapper);
    expect(result.qoder).toBe('');
    expect(result.calls).toContain('unsetenv|QODER_WORKER_RUNTIME_PATH|');
    expect(existsSync(plist('qoderwork-env'))).toBe(false);
    expect(existsSync(wrapper)).toBe(true);
  });

  it.each(['current-custom', 'legacy-default'])('cleans %s Pilot env/plist for non-CN-only upgrades', kind => {
    app('QoderWork.app');
    writeFileSync(plist('qoderwork-env'), 'legacy Pilot plist');
    const oldPath = kind === 'current-custom' ? wrapper
      : join(home, '.loongsuite-pilot', 'hooks', 'qoderwork-runtime-wrapper.mjs');
    const result = runInstaller('qoder-work', oldPath);
    expect(result.qoder).toBe('');
    expect(result.calls).toContain('unsetenv|QODER_WORKER_RUNTIME_PATH|');
    expect(existsSync(plist('qoderwork-env'))).toBe(false);
    expect(existsSync(wrapper)).toBe(true);
  });

  it('cleans shared Qoder env without removing active Qwen env/plist or wrapper', () => {
    app('QwenWorkCN.app');
    app('QoderWork.app');
    writeFileSync(plist('qoderwork-env'), 'legacy Pilot plist');
    writeFileSync(plist('qwenworkcn-env'), 'active Pilot plist');
    const result = runInstaller('qoder-work,qwen-work-cn', wrapper, wrapper);
    expect(result.qoder).toBe('');
    expect(result.qwen).toBe(wrapper);
    expect(existsSync(plist('qoderwork-env'))).toBe(false);
    expect(readFileSync(plist('qwenworkcn-env'), 'utf8')).toContain(wrapper);
    expect(existsSync(wrapper)).toBe(true);
    expect(result.calls).not.toContain('unsetenv|QW_QODER_WORKER_RUNTIME_PATH|');
  });

  it('keeps only the Qwen runtime target when all three desktop products are selected', () => {
    app('QoderWorkCN.app');
    app('QwenWorkCN.app');
    writeFileSync(plist('qoderwork-env'), 'legacy Pilot plist');
    const result = runInstaller('qoder-work,qoder-work-cn,qwen-work-cn', wrapper, wrapper);
    expect(result.qoder).toBe('');
    expect(result.qwen).toBe(wrapper);
    expect(existsSync(plist('qoderwork-env'))).toBe(false);
    expect(readFileSync(plist('qwenworkcn-env'), 'utf8')).toContain(wrapper);
    expect(result.calls).not.toContain('unsetenv|QW_QODER_WORKER_RUNTIME_PATH|');
    expect(existsSync(wrapper)).toBe(true);
  });

  it.each(['qoder-work', 'qoder-work,qwen-work-cn'])('preserves third-party env during cleanup for %s', selection => {
    app('QwenWorkCN.app');
    const result = runInstaller(selection, '/third-party/runtime.mjs', '/third-party/qwen.mjs');
    expect(result.qoder).toBe('/third-party/runtime.mjs');
    if (selection === 'qoder-work') expect(result.qwen).toBe('/third-party/qwen.mjs');
    expect(result.calls).not.toContain('unsetenv|');
  });
});
