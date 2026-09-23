import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const paths = ['deploy/installer-opensource.sh', 'scripts/loongsuite-pilot.sh', 'deploy/installer-opensource.ps1', 'scripts/loongsuite-pilot.ps1'];
const sources = paths.map(path => readFileSync(path, 'utf8'));
function body(source, index) {
  const marker = index < 2 ? "<<'QWENPAW_CLEANUP_NODE'\n" : "$cleanupScript = @'\n";
  const functionStart = source.indexOf(index < 2 ? (index === 0 ? 'remove_qwenpaw_plugin()' : 'cleanup_qwenpaw_for_rollback()') : 'function Remove-QwenPawPlugin');
  const start = source.indexOf(marker, functionStart) + marker.length;
  const end = source.indexOf(index < 2 ? '\nQWENPAW_CLEANUP_NODE' : "\n'@", start);
  return source.slice(start, end);
}
const programs = sources.map(body);
function temporary(run) {
  const root = mkdtempSync(join(tmpdir(), 'pilot-qwen-cleanup-'));
  try {
    const data = join(root, 'pilot 数据');
    const fallback = join(root, 'qwen default', 'plugins', 'loongsuite-pilot');
    const recorded = join(root, 'custom runtime', 'plugins', 'loongsuite-pilot');
    mkdirSync(data, { recursive: true });
    return run({ root, data, fallback, recorded });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function install(target, data, meta = {}) {
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'plugin.py'), '# test plugin');
  writeFileSync(join(target, '.loongsuite-pilot-managed.json'), JSON.stringify({ owner: 'loongsuite-pilot', agentId: 'qwenpaw', dataDir: data, ...meta }));
}
function state(data, target) {
  writeFileSync(join(data, 'deployed-agents.json'), JSON.stringify({ qwenpaw: { targetDir: target }, other: { version: 'keep' } }));
}
function run(program, data, fallback) {
  const result = spawnSync(process.execPath, ['-e', program, data, fallback], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
}

describe('QwenPaw native directory plugin lifecycle cleanup', () => {
  it('shares the same ownership checks in POSIX and Windows entry points', () => {
    for (const program of programs) expect(program).toBe(programs[0]);
  });
  for (const [index, program] of programs.entries()) {
    describe(paths[index], () => {
      it('removes the recorded custom target and prunes only its own state', () => temporary(({ data, fallback, recorded }) => {
        install(recorded, data);
        install(fallback, data);
        state(data, recorded);
        run(program, data, fallback);
        expect(existsSync(recorded)).toBe(false);
        expect(existsSync(fallback)).toBe(true);
        expect(JSON.parse(readFileSync(join(data, 'deployed-agents.json'), 'utf8'))).toEqual({ other: { version: 'keep' } });
      }));
      it('uses the environment-derived fallback when no state exists', () => temporary(({ data, fallback }) => {
        install(fallback, data);
        run(program, data, fallback);
        expect(existsSync(fallback)).toBe(false);
      }));
      it('preserves an unmarked user plugin and its deployment state', () => temporary(({ data, fallback, recorded }) => {
        mkdirSync(recorded, { recursive: true });
        writeFileSync(join(recorded, 'plugin.py'), '# user plugin');
        state(data, recorded);
        run(program, data, fallback);
        expect(readFileSync(join(recorded, 'plugin.py'), 'utf8')).toBe('# user plugin');
        expect(JSON.parse(readFileSync(join(data, 'deployed-agents.json'), 'utf8')).qwenpaw.targetDir).toBe(recorded);
      }));
      it('preserves a plugin managed by another Pilot installation', () => temporary(({ root, data, fallback, recorded }) => {
        const other = join(root, 'other-data');
        mkdirSync(other);
        install(recorded, other);
        state(data, recorded);
        run(program, data, fallback);
        expect(existsSync(recorded)).toBe(true);
      }));
      it('preserves forged-owner, missing-dataDir and malformed markers', () => temporary(({ data, fallback }) => {
        for (const contents of [JSON.stringify({ owner: 'other', agentId: 'qwenpaw', dataDir: data }), JSON.stringify({ owner: 'loongsuite-pilot', agentId: 'qwenpaw' }), '{broken']) {
          install(fallback, data);
          writeFileSync(join(fallback, '.loongsuite-pilot-managed.json'), contents);
          run(program, data, fallback);
          expect(existsSync(fallback)).toBe(true);
        }
      }));
      it('preserves symlink targets instead of deleting their contents', () => temporary(({ data, fallback, recorded }) => {
        install(recorded, data);
        mkdirSync(dirname(fallback), { recursive: true });
        symlinkSync(recorded, fallback, 'dir');
        run(program, data, fallback);
        expect(existsSync(join(recorded, 'plugin.py'))).toBe(true);
        expect(existsSync(fallback)).toBe(true);
      }));
    });
  }
  it('executes the POSIX uninstall function with the custom runtime environment', () => temporary(({ root, data, fallback }) => {
    install(fallback, data);
    const start = sources[0].indexOf('remove_qwenpaw_plugin() {');
    const end = sources[0].indexOf('\n}\n', start) + 3;
    const script = `${sources[0].slice(start, end)}\nresolve_node() { printf '%s' "$TEST_NODE"; }\nremove_qwenpaw_plugin\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, DATA_DIR: data, HOME: root, QWENPAW_WORKING_DIR: dirname(dirname(fallback)), TEST_NODE: process.execPath } });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(fallback)).toBe(false);
  }));
  it('executes rollback cleanup only when the previous version lacks QwenPaw', () => temporary(({ root, data, fallback }) => {
    install(fallback, data);
    const targetVersion = join(root, 'old-version');
    mkdirSync(join(targetVersion, 'agents.d'), { recursive: true });
    const definition = join(targetVersion, 'agents.d', 'qwenpaw.json');
    writeFileSync(definition, '{}');
    const start = sources[1].indexOf('cleanup_qwenpaw_for_rollback() {');
    const end = sources[1].indexOf('\n}\n', start) + 3;
    const script = `${sources[1].slice(start, end)}\nresolve_node() { printf '%s' "$TEST_NODE"; }\ncleanup_qwenpaw_for_rollback "$TEST_VERSION"\n`;
    const env = { ...process.env, DATA_DIR: data, HOME: root, QWENPAW_WORKING_DIR: dirname(dirname(fallback)), TEST_NODE: process.execPath, TEST_VERSION: targetVersion };
    let result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(fallback)).toBe(true);
    rmSync(definition);
    result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(fallback)).toBe(false);
  }));
  it('wires cleanup before removing assets and after selecting rollback target', () => {
    expect(sources[0].slice(sources[0].indexOf('cmd_uninstall()'))).toContain('remove_qwenpaw_plugin');
    expect(sources[1].slice(sources[1].indexOf('cmd_rollback()'))).toContain('cleanup_qwenpaw_for_rollback "$VERSIONS_DIR/$prev_dir"');
    expect(sources[2].slice(sources[2].indexOf('function Cmd-Uninstall'))).toContain('Remove-QwenPawPlugin');
    expect(sources[3].slice(sources[3].indexOf('function Cmd-Rollback'))).toContain('Remove-QwenPawPluginForRollback $prevPath');
    for (const source of sources) expect(source).not.toMatch(/qwenpaw[^\n]*plugin install/);
  });
});
