// Static wiring tests: every installer variant and hook fallback must carry
// the managed Node.js runtime integration, per design doc M2/M3.
//
// Variants that only exist in the internal repo (installer.sh, installer-inner.*,
// installer.ps1) are skipped when the file is absent, so the same suite runs in
// the open-source repo where only installer-opensource.* is shipped.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SH_VARIANTS = ['installer.sh', 'installer-inner.sh', 'installer-opensource.sh'];
const PS1_VARIANTS = ['installer.ps1', 'installer-inner.ps1', 'installer-opensource.ps1'];
const HOOK_SH = [
  'claude-code', 'codex', 'cursor', 'kiro-cli', 'qoder', 'qodercn',
  'qoderwork', 'qoderworkcn', 'qwen-code-cli',
].map(a => `assets/hooks/${a}-loongsuite-pilot-hook.sh`);

describe('sh installer variants wire the managed node runtime', () => {
  for (const f of SH_VARIANTS) {
    const present = existsSync(resolve('deploy', f));
    const sh = present ? readFileSync(resolve('deploy', f), 'utf-8') : '';
    it.skipIf(!present)(`${f} defines ensure_managed_node and ensure_node_modules`, () => {
      expect(sh).toMatch(/ensure_managed_node\(\)\s*\{/);
      expect(sh).toMatch(/ensure_node_modules\(\)\s*\{/);
    });
    it.skipIf(!present)(`${f} supports env overrides and --prefer-system-node`, () => {
      expect(sh).toContain('LOONGSUITE_PILOT_NODE_VERSION');
      expect(sh).toContain('LOONGSUITE_PILOT_NODE_DEPS_URL');
      expect(sh).toContain('LOONGSUITE_PILOT_NODE_MODULES_URL');
      expect(sh).toContain('--prefer-system-node');
      expect(sh).toContain('PREFER_SYSTEM_NODE=0');
    });
    it.skipIf(!present)(`${f} verifies SHASUMS256.txt and de-quarantines on macOS`, () => {
      expect(sh).toContain('SHASUMS256.txt');
      expect(sh).toContain('sha256 mismatch');
      expect(sh).toContain('xattr -dr com.apple.quarantine');
    });
    it.skipIf(!present)(`${f} rejects musl and win-arm64 with explicit notices`, () => {
      expect(sh).toContain('ld-musl-');
      expect(sh).toContain('win-arm64');
    });
    it.skipIf(!present)(`${f} check_deps prefers managed node by default with system fallback`, () => {
      const checkDeps = sh.slice(sh.indexOf('check_deps() {'));
      expect(checkDeps).toContain('ensure_managed_node');
      expect(checkDeps).toContain('resolve_node');
      expect(checkDeps).toContain('PREFER_SYSTEM_NODE');
    });
    it.skipIf(!present)(`${f} keeps npm install as the node_modules fallback`, () => {
      expect(sh).toContain('ensure_node_modules "$modules_ver"');
      expect(sh).toContain('install --production --no-optional');
    });
    it.skipIf(!present)(`${f} runs npm with the node bin dir on PATH`, () => {
      // npm from the managed runtime is a symlink to npm-cli.js, whose
      // `#!/usr/bin/env node` shebang needs node on PATH. Calling "$NPM_BIN"
      // directly breaks the npm install fallback on hosts without a system node.
      expect(sh).toMatch(/run_npm\(\)\s*\{/);
      expect(sh).toContain('PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" "$@"');
      expect(sh).toContain('run_npm install --production --no-optional');
      expect(sh).not.toContain('"$NPM_BIN" install');
      expect(sh).not.toContain('npm $("$NPM_BIN" --version)');
    });
    it.skipIf(!present)(`${f} prints an explicit notice before the npm install fallback`, () => {
      const noticePos = sh.indexOf('预编译 node_modules 不可用，回退 npm install');
      const npmPos = sh.indexOf('install --production --no-optional');
      expect(noticePos).toBeGreaterThan(-1);
      expect(npmPos).toBeGreaterThan(noticePos);
    });
    it.skipIf(!present)(`${f} supports both win layouts and cleans up failed extractions`, () => {
      const blk = sh.slice(sh.indexOf('# >>> managed-node-runtime >>>'), sh.indexOf('# <<< managed-node-runtime <<<'));
      expect(blk).toMatch(/managed_node_bin\(\)\s*\{/);
      expect(blk).toContain('"$1/node.exe"');
      expect(blk.split('rm -rf "$node_dir"').length - 1).toBeGreaterThanOrEqual(2);
    });
  }
});

describe('ps1 installer variants wire the managed node runtime', () => {
  for (const f of PS1_VARIANTS) {
    const present = existsSync(resolve('deploy', f));
    const ps1 = present ? readFileSync(resolve('deploy', f), 'utf-8') : '';
    it.skipIf(!present)(`${f} defines Ensure-ManagedNode and Ensure-NodeModules`, () => {
      expect(ps1).toMatch(/function Ensure-ManagedNode\s*\{/);
      expect(ps1).toMatch(/function Ensure-NodeModules\s*\{/);
    });
    it.skipIf(!present)(`${f} supports env overrides and -PreferSystemNode`, () => {
      expect(ps1).toContain('LOONGSUITE_PILOT_NODE_VERSION');
      expect(ps1).toContain('LOONGSUITE_PILOT_NODE_DEPS_URL');
      expect(ps1).toContain('LOONGSUITE_PILOT_NODE_MODULES_URL');
      expect(ps1).toContain('[switch]$PreferSystemNode');
    });
    it.skipIf(!present)(`${f} verifies SHASUMS256.txt via Get-FileHash and rejects win-arm64`, () => {
      expect(ps1).toContain('SHASUMS256.txt');
      expect(ps1).toContain('Get-FileHash -Algorithm SHA256');
      expect(ps1).toContain('ARM64');
    });
    it.skipIf(!present)(`${f} Check-Deps prefers managed node by default with system fallback`, () => {
      const checkDeps = ps1.slice(ps1.indexOf('function Check-Deps'));
      expect(checkDeps).toContain('Ensure-ManagedNode');
      expect(checkDeps).toContain('Resolve-Node');
      expect(checkDeps).toContain('$PreferSystemNode');
    });
    it.skipIf(!present)(`${f} keeps npm install as the node_modules fallback`, () => {
      expect(ps1).toContain('Ensure-NodeModules $modulesVer');
      expect(ps1).toMatch(/install --omit=dev/);
    });
    it.skipIf(!present)(`${f} prepends the node dir to PATH for the npm fallback`, () => {
      // Windows counterpart of run_npm in the sh installers.
      const fallback = ps1.slice(ps1.indexOf('Prebuilt node_modules unavailable'));
      const pathPos = fallback.indexOf('$env:PATH = "$nodeDir;$env:PATH"');
      const npmPos = fallback.search(/install --omit=dev/);
      expect(pathPos).toBeGreaterThan(-1);
      expect(npmPos).toBeGreaterThan(pathPos);
    });
    it.skipIf(!present)(`${f} prints an explicit notice before the npm install fallback`, () => {
      const noticePos = ps1.indexOf('预编译 node_modules 不可用，回退 npm install');
      const npmPos = ps1.search(/install --omit=dev/);
      expect(noticePos).toBeGreaterThan(-1);
      expect(npmPos).toBeGreaterThan(noticePos);
    });
    it.skipIf(!present)(`${f} supports both win layouts and cleans up failed extractions`, () => {
      expect(ps1).toMatch(/function Resolve-ManagedNodeBin\s*\{/);
      expect(ps1).toContain('Join-Path $NodeDir "node.exe"');
      const ensure = ps1.slice(ps1.indexOf('function Ensure-ManagedNode'), ps1.indexOf('function Ensure-NodeModules'));
      expect(ensure.split('Remove-Item $nodeDir').length - 1).toBeGreaterThanOrEqual(3);
    });
  }
});

describe('hook fallbacks prefer the managed runtime node', () => {
  for (const f of HOOK_SH) {
    const sh = readFileSync(resolve(f), 'utf-8');
    it(`${f} lists runtime/ candidates before nvm`, () => {
      const runtimePos = sh.indexOf('runtime_dir="$(dirname "$NODE_PIN_FILE")/runtime"');
      const nvmPos = sh.indexOf('.nvm/versions/node');
      expect(runtimePos).toBeGreaterThan(-1);
      expect(nvmPos).toBeGreaterThan(runtimePos);
      expect(sh).toContain('"$runtime_dir"/node-v*');
    });
    it(`${f} orders version dirs numerically, not by reverse glob`, () => {
      expect(sh).toContain('sort_version_dirs_desc()');
      expect(sh).not.toContain('runtime_candidates=');
      expect(sh).not.toContain('nvm_candidates=');
    });
  }

  it('all hooks share one numeric sort helper with a sort -V fallback', () => {
    const fns = HOOK_SH.map(f => {
      const sh = readFileSync(resolve(f), 'utf-8');
      const m = sh.match(/sort_version_dirs_desc\(\) \{[\s\S]*?\n\}\n/);
      expect(m, f).not.toBeNull();
      return m[0];
    });
    expect(new Set(fns).size).toBe(1);
    expect(fns[0]).toContain('sort -rV');
    // BSD/macOS sort lacks -V; the zero-padded key fallback must be present.
    expect(fns[0]).toContain('sort -V >/dev/null 2>&1');
    expect(fns[0]).toContain("printf '%04d.%04d.%04d|%s\\n'");
  });

  it('common.ps1 Resolve-NodeBin lists runtime candidates first', () => {
    const ps1 = readFileSync(resolve('assets/hooks/shared/common.ps1'), 'utf-8');
    const resolveFn = ps1.slice(ps1.indexOf('function Resolve-NodeBin'));
    const runtimePos = resolveFn.indexOf('$runtimeDir');
    const voltaPos = resolveFn.indexOf('.volta');
    expect(runtimePos).toBeGreaterThan(-1);
    expect(voltaPos).toBeGreaterThan(runtimePos);
    expect(resolveFn).toContain('bin\\node.exe');
    expect(resolveFn.split('Join-Path $d.FullName "node.exe"').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('common.ps1 sorts version dirs numerically via Get-NodeVersionSortKey', () => {
    const ps1 = readFileSync(resolve('assets/hooks/shared/common.ps1'), 'utf-8');
    expect(ps1).toContain('function Get-NodeVersionSortKey');
    const resolveFn = ps1.slice(ps1.indexOf('function Resolve-NodeBin'), ps1.indexOf('# CLM/WDAC-safe'));
    expect(resolveFn).not.toContain('Sort-Object Name -Descending');
    expect(resolveFn.split('Get-NodeVersionSortKey $_.Name').length - 1).toBeGreaterThanOrEqual(3);
  });
});
