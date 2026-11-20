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

describe.skipIf(!HAS_BASH)('installer runtime retirement (temporary HOME, mocked launchctl)', () => {
  const installer = readFileSync(new URL('../../../deploy/installer-opensource.sh', import.meta.url), 'utf8');
  const cleanupName = 'retire_qoderwork_runtime_overrides';
  function installerFunction(name: string): string {
    const match = installer.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
    if (!match) throw new Error(`Missing installer function: ${name}`);
    return match[0];
  }
  const cleanup = installerFunction(cleanupName);
  const plistIds = ['qoderwork-env', 'qwenworkcn-env'];
  let home: string;
  let dataDir: string;
  let wrapper: string;

  function plist(id: string): string {
    return join(home, 'Library', 'LaunchAgents', `com.loongsuite-pilot.${id}.plist`);
  }

  function runCleanup(qoder = '', qwen = '', selection?: string, platform = 'Darwin', repetitions = 1) {
    writeFileSync(join(home, 'launchctl.calls'), '');
    execFileSync('bash', ['--noprofile', '--norc', '-c', `
set -euo pipefail
uname() { printf '%s\\n' "$TEST_PLATFORM"; }
msg() { :; }
launchctl() {
  printf '%s|%s|%s\\n' "$1" "$2" "\${3-}" >> "$HOME/launchctl.calls"
  case "$1" in
    getenv) local key="$2"; [ -n "\${!key-}" ] || return 1; printf '%s\\n' "\${!key}" ;;
    unsetenv) unset "$2" ;;
    unload) [[ "$2" == "$HOME/Library/LaunchAgents/"* ]] ;;
    *) return 99 ;;
  esac
}
${cleanup}
for ((i = 0; i < ${repetitions}; i++)); do ${cleanupName}; done
printf '%s' "\${QODER_WORKER_RUNTIME_PATH-}" > "$HOME/qoder.env"
printf '%s' "\${QW_QODER_WORKER_RUNTIME_PATH-}" > "$HOME/qwen.env"
`], {
      encoding: 'utf8',
      env: {
        ...process.env, HOME: home, BASH_ENV: '', ENV: '', DATA_DIR: dataDir,
        SELECTED_AGENTS: selection, TEST_PLATFORM: platform,
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

  function expectRetired(result: ReturnType<typeof runCleanup>) {
    expect(result.qoder).toBe('');
    expect(result.qwen).toBe('');
    for (const name of ['QODER_WORKER_RUNTIME_PATH', 'QW_QODER_WORKER_RUNTIME_PATH']) {
      expect(result.calls).toContain(`unsetenv|${name}|`);
    }
    for (const id of plistIds) {
      expect(existsSync(plist(id))).toBe(false);
      expect(result.calls).toContain(`unload|${plist(id)}|`);
    }
    expect(result.calls).not.toMatch(/^(setenv|load)\|/m);
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'installer-runtime-'));
    dataDir = join(home, 'custom data');
    wrapper = join(dataDir, 'hooks', 'qoderwork-runtime-wrapper.mjs');
    mkdirSync(join(dataDir, 'hooks'), { recursive: true });
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(wrapper, '// shared runtime wrapper\n');
    for (const id of plistIds) writeFileSync(plist(id), 'legacy Pilot plist');
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it.each(['qoder-work', 'qoder-work-cn', 'qwen-work-cn', 'qoder-work,qoder-work-cn,qwen-work-cn', '', undefined])(
    'retires both custom-dataDir overrides regardless of selection %s', selection => {
      for (const app of ['QoderWork.app', 'QoderWorkCN.app', 'QwenWorkCN.app']) {
        mkdirSync(join(home, 'Applications', app), { recursive: true });
      }
      expectRetired(runCleanup(wrapper, wrapper, selection));
      expect(readFileSync(wrapper, 'utf8')).toBe('// shared runtime wrapper\n');
    },
  );

  it.each(['both', 'qoder', 'qwen'])('recognizes legacy Pilot paths for %s overrides', legacy => {
    const oldPath = join(home, '.loongsuite-pilot', 'hooks', 'qoderwork-runtime-wrapper.mjs');
    const qoder = legacy === 'qwen' ? wrapper : oldPath;
    const qwen = legacy === 'qoder' ? wrapper : oldPath;
    expectRetired(runCleanup(qoder, qwen));
    expect(existsSync(wrapper)).toBe(true);
  });

  it('cleans both overrides and plists without apps, config, dataDir or wrapper', () => {
    rmSync(dataDir, { recursive: true });
    expectRetired(runCleanup(wrapper, wrapper));
    expect(existsSync(dataDir)).toBe(false);
  });

  it('cleans both overrides even if the LaunchAgents directory is missing', () => {
    rmSync(join(home, 'Library'), { recursive: true });
    const result = runCleanup(wrapper, wrapper);
    expect(result.qoder).toBe('');
    expect(result.qwen).toBe('');
    expect(result.calls.match(/^unsetenv\|/gm)).toHaveLength(2);
    expect(result.calls).not.toContain('unload|');
    expect(existsSync(join(home, 'Library'))).toBe(false);
    expect(existsSync(wrapper)).toBe(true);
  });

  it('preserves third-party overrides and plists while removing both Pilot plists', () => {
    const otherPlist = join(home, 'Library', 'LaunchAgents', 'com.third-party.runtime.plist');
    writeFileSync(otherPlist, 'third-party plist');
    const qoder = join(home, 'other data', 'hooks', 'qoderwork-runtime-wrapper.mjs');
    const qwen = `${wrapper}.third-party`;
    const result = runCleanup(qoder, qwen, 'qwen-work-cn');
    expect(result.qoder).toBe(qoder);
    expect(result.qwen).toBe(qwen);
    expect(result.calls).not.toContain('unsetenv|');
    expect(result.calls).not.toContain(otherPlist);
    expect(readFileSync(otherPlist, 'utf8')).toBe('third-party plist');
    for (const id of plistIds) expect(existsSync(plist(id))).toBe(false);
    expect(existsSync(wrapper)).toBe(true);
  });

  it.each(['qoder', 'qwen'])('retires only the Pilot-owned %s override in mixed ownership', owned => {
    const thirdParty = '/third-party/runtime.mjs';
    const result = runCleanup(owned === 'qoder' ? wrapper : thirdParty, owned === 'qwen' ? wrapper : thirdParty);
    expect(result.qoder).toBe(owned === 'qoder' ? '' : thirdParty);
    expect(result.qwen).toBe(owned === 'qwen' ? '' : thirdParty);
    expect(result.calls.match(/^unsetenv\|/gm)).toHaveLength(1);
  });

  it('is idempotent and tolerates getenv returning nonzero for absent overrides', () => {
    const result = runCleanup(wrapper, wrapper, '', 'Darwin', 2);
    expectRetired(result);
    expect(result.calls.match(/^unsetenv\|/gm)).toHaveLength(2);
    expect(result.calls.match(/^unload\|/gm)).toHaveLength(2);
    expect(result.calls.match(/^getenv\|/gm)).toHaveLength(4);
    const again = runCleanup();
    expect(again.qoder).toBe('');
    expect(again.qwen).toBe('');
    expect(again.calls).not.toMatch(/^(unsetenv|unload)\|/m);
    expect(existsSync(wrapper)).toBe(true);
  });

  it('removes stale Pilot plists even when both overrides are already absent', () => {
    const result = runCleanup();
    expect(result.calls).not.toContain('unsetenv|');
    for (const id of plistIds) expect(existsSync(plist(id))).toBe(false);
    expect(existsSync(wrapper)).toBe(true);
  });

  it('is a Linux no-op', () => {
    const result = runCleanup(wrapper, wrapper, 'qwen-work-cn', 'Linux');
    expect(result.qoder).toBe(wrapper);
    expect(result.qwen).toBe(wrapper);
    expect(result.calls).toBe('');
    for (const id of plistIds) expect(readFileSync(plist(id), 'utf8')).toBe('legacy Pilot plist');
    expect(existsSync(wrapper)).toBe(true);
  });

  it('has no active injector, app probes, selection gates or wrapper existence gates', () => {
    expect(installer).not.toMatch(/inject_qoderwork_runtime_wrapper|remove_qoderwork_runtime_wrapper|retire_qoderwork_runtime_env/);
    expect(installer).not.toMatch(/launchctl\s+setenv\s+(QW_)?QODER_WORKER_RUNTIME_PATH/);
    expect(cleanup).not.toMatch(/SELECTED_AGENTS|Applications|config\.json|\[\s+!?\s*-[fd]\s+"\$DATA_DIR/);
    expect(cleanup).not.toContain('/bin/launchctl');
    expect(cleanup).not.toMatch(/\b(setenv|load|mkdir)\b/);
  });

  it.each(['install', 'upgrade', 'uninstall'])('calls shared cleanup unconditionally from cmd_%s', command => {
    const body = installerFunction(`cmd_${command}`);
    expect(body.match(new RegExp(`^    ${cleanupName}$`, 'gm'))).toHaveLength(1);
    if (command === 'uninstall') {
      expect(body.indexOf(cleanupName)).toBeLessThan(body.indexOf('local _cache_dir="$HOME/.loongsuite-pilot"'));
      expect(body).toContain(`    remove_qoderclicn_token_intercept\n    ${cleanupName}\n    remove_claude_code_fetch_intercept`);
    } else {
      expect(body).toContain(`    install_loongsuite_pilot_command\n    ${cleanupName}\n`);
      expect(body.indexOf(cleanupName)).toBeGreaterThan(body.indexOf('stop_pilot_for_deploy'));
      expect(body.indexOf(cleanupName)).toBeGreaterThan(body.indexOf('deploy_package'));
      expect(body.indexOf(cleanupName)).toBeLessThan(body.lastIndexOf('if run_pilot_cli start; then'));
    }
  });
});
