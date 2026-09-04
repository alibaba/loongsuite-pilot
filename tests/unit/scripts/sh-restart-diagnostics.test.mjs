// The POSIX half of the restart diagnostics contract, kept symmetric with
// tests/unit/scripts/ps1-restart-diagnostics.test.mjs.
//
// Same defect, same fix: restart-collector / restart-updater used to end in
// "Service manager failed to restart <x> (init_type=...)" with the actual cause either
// unprinted or lost, and several branches (`systemctl --user is-enabled` missing a unit,
// a launchd job that is not loaded) said nothing at all. Every non-success exit now names
// a stage and leaves the same breadcrumb file the .ps1 writes, which the calling
// collector/updater reads via src/utils/restart-breadcrumb.ts.
//
// This file also pins the two `set -euo pipefail` hazards that would silently gut the
// diagnostics on the platforms this script actually runs on.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SERVICE_SH = 'scripts/loongsuite-pilot.sh';
const BREADCRUMB_TS = 'src/utils/restart-breadcrumb.ts';
const text = readFileSync(SERVICE_SH, 'utf-8');

// Drop comment lines so prose about write_restart_failure cannot satisfy a structural check.
const codeOf = (s) => s.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

// Body = from the function header to the next top-level `name() {` declaration.
const bodyOf = (name) => {
  const start = text.indexOf(`\n${name}() {`);
  expect(start, `${name} not found in ${SERVICE_SH}`).toBeGreaterThan(-1);
  const rest = text.slice(start + `\n${name}() {`.length);
  const end = rest.search(/\n[a-z_][a-z0-9_]*\(\) \{/);
  return codeOf(end === -1 ? rest : rest.slice(0, end));
};

const RESTART_CMDS = [
  // Collector start/self-heal lives in start_collector_after_stop so restart-collector
  // and the #328 start-collector recovery path share one ladder. The updater command
  // stays self-contained because there is no equivalent start-updater recovery.
  { fn: 'start_collector_after_stop', target: 'collector', wait: 'wait_for_collector_process', exit: 'return 1', verb: 'start' },
  { fn: 'cmd_restart_updater', target: 'updater', wait: 'wait_for_updater_process', exit: 'return 1', verb: 'restart' },
];

describe('restart commands report every failure path', () => {
  for (const { fn, target, exit, verb } of RESTART_CMDS) {
    it(`${fn}: every \`${exit}\` is preceded by write_restart_failure`, () => {
      const body = bodyOf(fn);
      const exits = [...body.matchAll(new RegExp(`^[ \\t]*${exit}\\b`, 'gm'))];
      expect(exits.length, `${fn} has no ${exit} to check`).toBeGreaterThan(1);
      let from = 0;
      exits.forEach((match, i) => {
        const segment = body.slice(from, match.index);
        expect(
          segment.includes('write_restart_failure'),
          `${fn}: the \`${exit}\` at exit #${i + 1} has no write_restart_failure before it, so `
            + 'the caller gets an exit code with no cause attached',
        ).toBe(true);
        from = match.index;
      });
    });

    it(`${fn}: the final exit reports the stage it reached, not just init_type`, () => {
      const body = bodyOf(fn);
      expect(body).toContain(`write_restart_failure ${target} "$_stage" "$_detail"`);
      expect(body).toContain(
        `Service manager failed to ${verb} ${target} (init_type=$init_type stage=$_stage): $_detail`,
      );
    });
  }

  it('cmd_restart_collector clears the previous breadcrumb before start_collector_after_stop', () => {
    // start_collector_after_stop is also the #328 recovery path; clearing inside it
    // would wipe the restart-collector breadcrumb the updater just failed on.
    const body = bodyOf('cmd_restart_collector');
    const clearAt = body.indexOf('clear_restart_failure collector');
    expect(clearAt, 'cmd_restart_collector does not clear the collector breadcrumb').toBeGreaterThan(-1);
    expect(body.indexOf('start_collector_after_stop')).toBeGreaterThan(clearAt);
  });

  it('cmd_restart_updater clears the previous breadcrumb before doing anything', () => {
    const body = bodyOf('cmd_restart_updater');
    const clearAt = body.indexOf('clear_restart_failure updater');
    expect(clearAt, 'cmd_restart_updater does not clear the updater breadcrumb').toBeGreaterThan(-1);
    expect(body.indexOf('write_restart_failure')).toBeGreaterThan(clearAt);
  });
});

describe('restart commands verify the process actually came up', () => {
  for (const { fn, wait } of RESTART_CMDS) {
    it(`${fn}: confirms liveness after the service manager reports success`, () => {
      // The service manager accepting a start request is not the same as the process
      // existing. The old single check one second later produced false "not running"
      // verdicts, which then surfaced as an unexplained restart failure.
      const body = bodyOf(fn);
      const waits = [...body.matchAll(new RegExp(`${wait} \\d+`, 'g'))];
      expect(waits.length, `${fn} does not wait for the process`).toBeGreaterThan(2);
      const successAt = body.indexOf('if [ "$_restarted" = true ]; then');
      expect(successAt, `${fn} does not re-check a reported-successful start`).toBeGreaterThan(-1);
      expect(body.slice(successAt, successAt + 300)).toContain(wait);
    });
  }

  for (const wait of ['wait_for_collector_process', 'wait_for_updater_process']) {
    it(`${wait} polls up to a bounded timeout`, () => {
      const body = bodyOf(wait);
      expect(body).toMatch(/local timeout="\$\{1:-\d+\}"/);
      expect(body).toContain('while [ "$i" -lt "$timeout" ]');
      expect(body).toContain('return 1');
    });
  }

  it('wait_for_updater_process only accepts this install\'s own updater', () => {
    // updater_process_exists() ends in a machine-wide `pgrep -f
    // loongsuite-pilot/bin/updater-daemon`. Measured: a run whose registration silently did
    // nothing still reported "self-healed", because another data dir's updater was alive.
    // find_current_user_processes matches this install's exact bootstrap path.
    const body = bodyOf('wait_for_updater_process');
    expect(body).toContain('find_current_user_processes updater');
    expect(body).not.toContain('updater_process_exists');
  });
});

describe('self-heal is reachable on a managed install', () => {
  // The stop section at the top of each command also switches on init_type, so the
  // fallback gate has to be located relative to the self-heal branch.
  const branches = (fn) => {
    const body = bodyOf(fn);
    const selfHealAt = body.indexOf('if [ "$_restarted" = false ]; then');
    expect(selfHealAt, `${fn} has no self-heal branch`).toBeGreaterThan(-1);
    const fallbackAt = body.indexOf('case "$init_type" in', selfHealAt);
    expect(fallbackAt, `${fn} has no init_type-gated fallback`).toBeGreaterThan(selfHealAt);
    return { body, selfHealAt, fallbackAt };
  };

  for (const { fn } of RESTART_CMDS) {
    it(`${fn}: the self-heal branch is not gated on init_type`, () => {
      // The original defect: an install whose unit had gone missing was not allowed to
      // re-register itself, so it could only reach the failure exit -- every cycle, forever.
      const { body, selfHealAt, fallbackAt } = branches(fn);
      expect(
        body.slice(selfHealAt, fallbackAt).includes('$init_type'),
        `${fn}: the self-heal branch still consults $init_type`,
      ).toBe(false);
    });

    it(`${fn}: the unmanaged nohup fallback stays gated`, () => {
      // On a managed install a bare nohup daemon is not a repair: it is a second process
      // outside the service manager, hiding the real breakage. Skipping it is reported.
      const { body, fallbackAt } = branches(fn);
      expect(body.slice(fallbackAt)).toContain('nohup|unknown|"")');
      expect(body.slice(fallbackAt)).toContain('write_restart_failure');
    });
  }
});

describe('the breadcrumb writer is safe for the reader', () => {
  const writer = bodyOf('write_restart_failure');

  it('writes to a temp file and renames into place', () => {
    // The reader may look at any moment; a half-written JSON file would parse as nothing.
    expect(writer).toContain('tmp="$file.tmp"');
    expect(writer).toMatch(/> "\$tmp" 2>\/dev\/null && mv -f "\$tmp" "\$file"/);
  });

  it('prints to stderr before touching the file', () => {
    // stderr is what the caller's error message carries, and it must survive a failed
    // write. The console copy is also the only one a human running the command by hand sees.
    const printAt = writer.indexOf('echo "[restart-failure] target=');
    expect(printAt).toBeGreaterThan(-1);
    expect(printAt).toBeLessThan(writer.indexOf('tmp="$file.tmp"'));
  });

  it('escapes every string it interpolates into the JSON', () => {
    // No jq on a customer box, so the JSON is hand-written: an unescaped quote from a
    // systemctl message would make the file unparseable, which readJsonFile degrades to
    // "no diagnostics" without a word.
    const printfLines = writer.split('\n').filter((l) => /printf '  "/.test(l) || /printf '    "/.test(l));
    expect(printfLines.length).toBeGreaterThan(4);
    for (const line of printfLines) {
      if (!line.includes('%s')) continue;
      if (/"ts": %s/.test(line)) continue; // a number, from date -u +%s
      expect(line, `unescaped interpolation: ${line.trim()}`).toContain('json_escape');
    }
    const escape = bodyOf('json_escape');
    expect(escape).toContain("tr '\\n\\r\\t'");
    expect(escape).toContain("tr -d '\\000-\\010\\013\\014\\016-\\037'");
    expect(escape).toContain('s/\\\\/\\\\\\\\/g');
    expect(escape).toContain('s/"/\\\\"/g');
  });

  it('json_escape strips ESC so handwritten JSON stays parseable', () => {
    const start = text.indexOf('\njson_escape() {');
    expect(start).toBeGreaterThan(-1);
    const rest = text.slice(start + 1);
    const end = rest.search(/\n[a-z_][a-z0-9_]*\(\) \{/);
    const fn = rest.slice(0, end === -1 ? undefined : end);
    const result = execFileSync(
      'bash',
      ['-c', `${fn}\nprintf '{"x":"%s"}\\n' "$(json_escape $'a\\x1bb')"`],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(result);
    expect(parsed.x).toBe('ab');
    expect(parsed.x).not.toContain('\x1b');
  });

  it('survives set -euo pipefail while collecting facts', () => {
    // pipefail makes a no-match grep inside $(...) fail the assignment, and with -e that
    // aborts the whole collection, throwing away every fact after it. Each probe that can
    // legitimately find nothing has to absorb its own failure.
    const collect = bodyOf('collect_restart_diag');
    const risky = collect.split('\n').filter((l) => /\$\(.*\|.*grep/.test(l) || /^\s*\[ -n .* \] && echo/.test(l));
    expect(risky.length).toBeGreaterThan(0);
    for (const line of risky) {
      expect(line.trimEnd(), `must not abort the collection: ${line.trim()}`).toMatch(/\|\| true$/);
    }
    // The collection itself is best-effort for the same reason.
    expect(writer).toContain('collect_restart_diag "$target" 2>/dev/null || true');
  });

  it('collects read-only', () => {
    // A diagnostic must not change the state it describes. `kill -0` probes, it does not
    // signal; nothing here removes a stale pid file the next probe would want to see.
    const collect = bodyOf('collect_restart_diag');
    expect(collect).toContain('kill -0 "$pid"');
    expect(collect).not.toMatch(/\brm\b/);
    expect(collect).not.toMatch(/\bkill -(9|TERM|15)\b/);
  });

  it('timestamps in UTC epoch seconds', () => {
    expect(writer).toContain('date -u +%s');
  });
});

describe('the two sides agree on the contract', () => {
  it('puts the breadcrumb where the node reader looks for it', () => {
    // restartFailurePath() builds <dataDir>/logs/last-restart-failure-<target>.json.
    expect(text).toContain('LOG_DIR="$DATA_DIR/logs"');
    expect(bodyOf('restart_failure_file')).toContain('echo "$LOG_DIR/last-restart-failure-$1.json"');
    expect(readFileSync(BREADCRUMB_TS, 'utf-8')).toContain("'logs', `last-restart-failure-${target}.json`");
  });

  it('every stage the script writes is known to restart-breadcrumb.ts', () => {
    // The stages are aggregation keys in the alarm stream. A label only one side knows
    // makes the alarm unqueryable, which is a silent failure of its own.
    const tsText = readFileSync(BREADCRUMB_TS, 'utf-8');
    const listed = tsText.slice(tsText.indexOf('RESTART_STAGES = ['), tsText.indexOf('] as const'));
    const known = new Set([...listed.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]));
    expect(known.size).toBeGreaterThan(5);

    const code = codeOf(text);
    const used = new Set([
      ...[...code.matchAll(/write_restart_failure \w+ "([a-z-]+)"/g)].map((m) => m[1]),
      ...[...code.matchAll(/_stage="([a-z-]+)"/g)].map((m) => m[1]),
    ]);
    expect(used.size).toBeGreaterThan(5);
    expect([...used].filter((stage) => !known.has(stage))).toEqual([]);
  });

  it('uses the same schema version the reader accepts', () => {
    expect(bodyOf('write_restart_failure')).toContain('"schema": 1');
  });
});
